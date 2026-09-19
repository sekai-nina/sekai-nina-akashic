import type { XMentionHit, XMentionWatch } from "@prisma/client";
import { prismaInternal } from "@/lib/db";
import { postDiscordWebhook } from "@/lib/status/discord";
import { recordJobRun } from "@/lib/status/jobs";
import { XApiError, clampRecentWindow, xSearchRecent } from "@/lib/twitter/x-search";
import { formatDate } from "@/lib/utils";
import { buildMentionQuery, isExcluded, newerTweetId } from "./query";

/**
 * X 言及監視の 1 回の実行。cron (`GET /api/cron/mentions`) と /mentions の「今すぐ実行」が呼ぶ。
 *
 * 1. 有効な監視語ごとに recent search を叩き、除外ユーザー以外を XMentionHit に入れる
 *    (同じツイートは (watchId, tweetId) の unique で 2 度入らない)
 * 2. 監視語ごとに lastTweetId を進める (次回の since_id)。X API に失敗した監視語は
 *    lastError に残して次へ進む (1 語の失敗で全体を止めない)
 * 3. 未通知のヒットを古い順に Discord へ 1 件 1 メッセージで送り、送れたものだけ notifiedAt を
 *    立てる。同じツイートが複数の監視語に当たっていても 1 回しか送らない。
 *    送信に失敗したらそこで打ち切る (残りは次回に再送)
 * 4. `/status` に `cron.x_mentions` のハートビートを残す (止まったら「報告が途絶えた」で気づける)
 *
 * セッション外で走るので DB は prismaInternal (RLS バイパス)。取ったものはすべて internal で入れる。
 */

export const JOB_KEY = "cron.x_mentions";
const JOB_NAME = "X 言及監視";
/** 1 日 1 回。/status はこの間隔の 2 倍を過ぎたら「報告が途絶えた」にする */
const JOB_INTERVAL_SEC = 86_400;

/** 1 監視語 1 回あたりのページ上限 (100 件/ページ)。読み取り枠の暴走防止 */
const MAX_PAGES = 2;
/** 初回 (since_id が無い) に遡る幅 */
const FIRST_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * since_id が古すぎると X API が拒むので、前回の確認からこれ以上空いていたら since_id を捨てて
 * 直近 7 日 (recent search の上限) を取り直す
 */
const SINCE_ID_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;
/** Discord webhook は 2 秒に 5 件。連投で 429 を踏まないよう 1 件ごとに空ける */
const DISCORD_GAP_MS = 500;
/**
 * 1 回の実行で送る上限。cron の maxDuration (60 秒) に収めるため。
 * 超えた分は notifiedAt が立たないまま残り、次回に続きから送る
 */
const MAX_NOTIFY_PER_RUN = 60;
/** 本文をメッセージに載せる長さ (Discord がリンクを展開するので全文は要らない) */
const TEXT_MAX_CHARS = 280;

export interface WatchRunResult {
  watchId: string;
  query: string;
  fetched: number;
  newHits: number;
  error: string | null;
}

export interface RunResult {
  startedAt: Date;
  watches: WatchRunResult[];
  newHits: number;
  /** Discord に送れた件数 (tweetId 単位) */
  notified: number;
  /** 送信に失敗して打ち切ったときのメッセージ */
  notifyError: string | null;
  discordConfigured: boolean;
}

export function isMentionDiscordConfigured(): boolean {
  return !!process.env.DISCORD_MENTION_WEBHOOK_URL?.trim();
}

export async function runMentionWatch(now: Date = new Date()): Promise<RunResult> {
  const startedAt = now;
  const setting = await prismaInternal.xMentionSetting.findUnique({ where: { id: "singleton" } });
  const excluded = setting?.excludedUsernames ?? [];
  const watches = await prismaInternal.xMentionWatch.findMany({ where: { enabled: true }, orderBy: { createdAt: "asc" } });

  const results: WatchRunResult[] = [];
  for (const watch of watches) {
    results.push(await runOneWatch(watch, excluded, now));
  }

  const { notified, notifyError } = await notifyPending();

  const newHits = results.reduce((n, r) => n + r.newHits, 0);
  const failed = results.filter((r) => r.error);
  const summary = [
    `${watches.length} 語を確認、新規 ${newHits} 件、通知 ${notified} 件`,
    ...failed.map((r) => `失敗: ${r.query} (${r.error})`),
    ...(notifyError ? [`通知に失敗: ${notifyError}`] : []),
  ].join(" / ");
  await recordJobRun(JOB_KEY, {
    status: failed.length || notifyError ? "error" : "ok",
    message: summary,
    count: newHits,
    durationMs: Date.now() - startedAt.getTime(),
    intervalSec: JOB_INTERVAL_SEC,
    name: JOB_NAME,
  }).catch((e) => console.error(`[mentions] ハートビートの記録に失敗: ${e instanceof Error ? e.message : e}`));

  return { startedAt, watches: results, newHits, notified, notifyError, discordConfigured: isMentionDiscordConfigured() };
}

/** 1 監視語ぶん。X API の失敗は lastError に残して結果で返す (throw しない) */
async function runOneWatch(watch: XMentionWatch, excluded: string[], now: Date): Promise<WatchRunResult> {
  const base = { watchId: watch.id, query: watch.query };
  const { query } = buildMentionQuery(watch.query, excluded);

  // 前回の続き (since_id) か、初回 / 長く空いたときの時間窓か
  const sinceUsable =
    !!watch.lastTweetId && !!watch.lastCheckedAt && now.getTime() - watch.lastCheckedAt.getTime() <= SINCE_ID_MAX_AGE_MS;
  const sinceId = sinceUsable ? watch.lastTweetId! : undefined;
  const windowStart = watch.lastTweetId ? now.getTime() - 7 * 24 * 60 * 60 * 1000 : now.getTime() - FIRST_RUN_WINDOW_MS;
  const { start } = sinceId ? { start: null } : clampRecentWindow(new Date(windowStart).toISOString(), null);

  try {
    const tweets = await xSearchRecent(query, start, null, MAX_PAGES, { sinceId });

    // since_id は除外ユーザーの投稿も含めた「見た中で最新」まで進める
    let newest: string | null = watch.lastTweetId;
    for (const t of tweets) newest = newerTweetId(newest, t.tweetId);

    const kept = tweets.filter((t) => !isExcluded(t.authorUsername, excluded));
    const created = kept.length
      ? await prismaInternal.xMentionHit.createMany({
          data: kept.map((t) => ({
            watchId: watch.id,
            tweetId: t.tweetId,
            authorUsername: t.authorUsername,
            authorName: t.authorName,
            text: t.text,
            tweetedAt: t.createdAt ? new Date(t.createdAt) : null,
            url: t.url,
          })),
          skipDuplicates: true,
        })
      : { count: 0 };

    await prismaInternal.xMentionWatch.update({
      where: { id: watch.id },
      data: { lastTweetId: newest, lastCheckedAt: now, lastError: "" },
    });
    return { ...base, fetched: tweets.length, newHits: created.count, error: null };
  } catch (e) {
    const message = e instanceof XApiError ? e.message : e instanceof Error ? e.message : String(e);
    await prismaInternal.xMentionWatch
      .update({ where: { id: watch.id }, data: { lastCheckedAt: now, lastError: message.slice(0, 500) } })
      .catch(() => {});
    return { ...base, fetched: 0, newHits: 0, error: message };
  }
}

/**
 * 未通知のヒットを Discord に流す。webhook 未設定なら何もしない (notifiedAt は立てない。
 * 設定した後の初回で溜まっていた分が流れるが、それは「保存はしていた」という意味で正しい)。
 */
async function notifyPending(): Promise<{ notified: number; notifyError: string | null }> {
  const url = process.env.DISCORD_MENTION_WEBHOOK_URL?.trim();
  if (!url) return { notified: 0, notifyError: null };

  const pending = await prismaInternal.xMentionHit.findMany({
    where: { notifiedAt: null },
    include: { watch: { select: { query: true } } },
    orderBy: [{ tweetedAt: "asc" }, { createdAt: "asc" }],
  });
  if (pending.length === 0) return { notified: 0, notifyError: null };

  // 同じツイートが複数の監視語に当たった分は 1 通にまとめる
  const groups = new Map<string, (XMentionHit & { watch: { query: string } })[]>();
  for (const h of pending) {
    const g = groups.get(h.tweetId);
    if (g) g.push(h);
    else groups.set(h.tweetId, [h]);
  }
  // 別の監視語ですでに送っているツイートは送らず既送扱いにする
  const alreadySent = new Set(
    (
      await prismaInternal.xMentionHit.findMany({
        where: { tweetId: { in: [...groups.keys()] }, notifiedAt: { not: null } },
        select: { tweetId: true },
      })
    ).map((h) => h.tweetId)
  );

  let notified = 0;
  let first = true;
  for (const [tweetId, hits] of groups) {
    const ids = hits.map((h) => h.id);
    if (!alreadySent.has(tweetId)) {
      if (notified >= MAX_NOTIFY_PER_RUN) {
        return { notified, notifyError: `1 回の上限 ${MAX_NOTIFY_PER_RUN} 件に達したので残りは次回に送ります` };
      }
      if (!first) await new Promise((r) => setTimeout(r, DISCORD_GAP_MS));
      first = false;
      try {
        await postDiscordWebhook(url, formatHitMessage(hits[0], hits.map((h) => h.watch.query)));
      } catch (e) {
        return { notified, notifyError: e instanceof Error ? e.message : String(e) };
      }
      notified += 1;
    }
    await prismaInternal.xMentionHit.updateMany({ where: { id: { in: ids } }, data: { notifiedAt: new Date() } });
  }
  return { notified, notifyError: null };
}

/**
 * 1 ヒットぶんのメッセージ。URL は裸で置いて Discord にツイートを展開させる。
 * 本文は長ければ切る (展開で全文が見える)。`allowed_mentions` は空なので @ が鳴ることはない
 */
export function formatHitMessage(hit: Pick<XMentionHit, "authorUsername" | "authorName" | "text" | "tweetedAt" | "url">, queries: string[]): string {
  const who = hit.authorName ? `${hit.authorName} (@${hit.authorUsername})` : `@${hit.authorUsername}`;
  const when = hit.tweetedAt ? formatDate(hit.tweetedAt, true) : "";
  const text = hit.text.replace(/\s+/g, " ").trim();
  const body = text.length > TEXT_MAX_CHARS ? `${text.slice(0, TEXT_MAX_CHARS)}…` : text;
  return [
    `🔎 **${queries.join(" / ")}** — ${who}${when ? `　${when}` : ""}`,
    `> ${body}`,
    hit.url,
  ].join("\n");
}
