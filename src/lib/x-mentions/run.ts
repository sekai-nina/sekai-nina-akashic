import type { XMentionHit, XMentionWatch } from "@prisma/client";
import { prismaInternal } from "@/lib/db";
import { postDiscordWebhook } from "@/lib/status/discord";
import { recordJobRun } from "@/lib/status/jobs";
import { XApiError, clampRecentWindow, xSearchRecent } from "@/lib/twitter/x-search";
import { formatDate } from "@/lib/utils";
import { JOB_KEY, SETTING_ID, buildMentionQuery, isExcluded, newerTweetId, tweetIdTimestampMs } from "./query";

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

const JOB_NAME = "X 言及監視";
/** 1 日 1 回。/status はこの間隔の 3 倍を過ぎたら「報告が途絶えた」にする */
const JOB_INTERVAL_SEC = 86_400;

/** 1 監視語 1 回あたりのページ上限 (100 件/ページ)。読み取り枠の暴走防止 */
const MAX_PAGES = 2;
const PAGE_SIZE = 100;
/** 初回 (since_id が無い) に遡る幅 */
const FIRST_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;
/** recent search が遡れる幅 */
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * since_id が recent search の窓より古いと X API が 400 で拒むので、ツイート ID から出した
 * 投稿時刻がこれより古ければ since_id を捨てて時間窓で取り直す (窓の端は避けて 6 日)
 */
const SINCE_ID_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;
/** since_id 無しで時間窓を使うとき、前回の確認時刻からこれだけ手前に戻して取りこぼしを防ぐ */
const WINDOW_OVERLAP_MS = 60 * 60 * 1000;
/** Discord webhook は 2 秒に 5 件。連投で 429 を踏まないよう 1 件ごとに空ける */
const DISCORD_GAP_MS = 500;
/**
 * 1 回の実行で送る上限。実行時間を抑えるため。超えた分は notifiedAt が立たないまま残り、
 * 次回に続きから送る (異常ではないので job は ok のまま、残り件数だけ伝える)
 */
const MAX_NOTIFY_PER_RUN = 60;
/** 本文をメッセージに載せる長さ (Discord がリンクを展開するので全文は要らない) */
const TEXT_MAX_CHARS = 280;
/** Discord に流してよい classification。上位機密に上げたヒットは保存だけして外に出さない */
const NOTIFIABLE_CLASSIFICATIONS = ["public", "internal"] as const;

export interface WatchRunResult {
  watchId: string;
  query: string;
  fetched: number;
  newHits: number;
  /** ページ上限に当たり、取りこぼした可能性がある */
  truncated: boolean;
  error: string | null;
}

export interface RunResult {
  startedAt: Date;
  watches: WatchRunResult[];
  newHits: number;
  /** Discord に送れた件数 (tweetId 単位) */
  notified: number;
  /** 上限で送り残した件数 (tweetId 単位)。次回に続きから送る */
  notifyRemaining: number;
  /** 送信に失敗して打ち切ったときのメッセージ */
  notifyError: string | null;
  discordConfigured: boolean;
}

export function isMentionDiscordConfigured(): boolean {
  return !!process.env.DISCORD_MENTION_WEBHOOK_URL?.trim();
}

export async function runMentionWatch(now: Date = new Date()): Promise<RunResult> {
  const startedAt = now;
  const setting = await prismaInternal.xMentionSetting.findUnique({ where: { id: SETTING_ID } });
  const excluded = setting?.excludedUsernames ?? [];
  const watches = await prismaInternal.xMentionWatch.findMany({ where: { enabled: true }, orderBy: { createdAt: "asc" } });

  const results: WatchRunResult[] = [];
  for (const watch of watches) {
    results.push(await runOneWatch(watch, excluded, now));
  }

  const { notified, remaining, notifyError } = await notifyPending();

  const newHits = results.reduce((n, r) => n + r.newHits, 0);
  const failed = results.filter((r) => r.error);
  const truncated = results.filter((r) => r.truncated);
  // Job.lastMessage は非保護テーブルに載ってログイン済み全員に見えるので、監視語の本文は写さない
  // (各監視語の失敗は /mentions が RLS の下で lastError を見せる)
  const summary = [
    `${watches.length} 語を確認、新規 ${newHits} 件、通知 ${notified} 件`,
    ...(remaining ? [`残り ${remaining} 件は次回`] : []),
    ...(truncated.length ? [`上限に当たった監視語 ${truncated.length} 語`] : []),
    ...(failed.length ? [`失敗 ${failed.length} 語`] : []),
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

  return {
    startedAt,
    watches: results,
    newHits,
    notified,
    notifyRemaining: remaining,
    notifyError,
    discordConfigured: isMentionDiscordConfigured(),
  };
}

/** 監視語ごとの取得範囲。since_id か時間窓のどちらか一方 (X API は両方を受け付けない) */
function searchRange(watch: XMentionWatch, now: Date): { sinceId?: string; start: string | null } {
  const idAt = tweetIdTimestampMs(watch.lastTweetId);
  if (watch.lastTweetId && idAt !== null && now.getTime() - idAt <= SINCE_ID_MAX_AGE_MS) {
    return { sinceId: watch.lastTweetId, start: null };
  }
  // 初回は直近 24 時間。前回の確認があれば (since_id が古すぎた / まだヒットが無い) そこから
  // 少し戻って、cron が 1 回飛んでも隙間を作らない。7 日より前は API が返さないので clamp
  const from = watch.lastCheckedAt
    ? Math.max(watch.lastCheckedAt.getTime() - WINDOW_OVERLAP_MS, now.getTime() - RECENT_WINDOW_MS)
    : now.getTime() - FIRST_RUN_WINDOW_MS;
  return { start: clampRecentWindow(new Date(from).toISOString(), null).start };
}

/** 1 監視語ぶん。X API の失敗は lastError に残して結果で返す (throw しない) */
async function runOneWatch(watch: XMentionWatch, excluded: string[], now: Date): Promise<WatchRunResult> {
  const base = { watchId: watch.id, query: watch.query };
  const { query } = buildMentionQuery(watch.query, excluded);

  try {
    let range = searchRange(watch, now);
    let tweets;
    try {
      tweets = await xSearchRecent(query, range.start, null, MAX_PAGES, { sinceId: range.sinceId });
    } catch (e) {
      // since_id を X が拒んだ (窓の外など) ときだけ、時間窓で 1 回やり直す
      if (!(e instanceof XApiError && e.status === 400 && range.sinceId)) throw e;
      range = searchRange({ ...watch, lastTweetId: null }, now);
      tweets = await xSearchRecent(query, range.start, null, MAX_PAGES);
    }

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

    // ページ上限いっぱいなら、その先 (since_id との間) を読めていない可能性がある。
    // 新しい順に返るので lastTweetId は進めるしかなく、取りこぼしは警告として残す
    const truncated = tweets.length >= MAX_PAGES * PAGE_SIZE;
    await prismaInternal.xMentionWatch.update({
      where: { id: watch.id },
      data: {
        lastTweetId: newest,
        lastCheckedAt: now,
        lastError: truncated
          ? `1 回の上限 ${MAX_PAGES * PAGE_SIZE} 件に達したため取りこぼしがあるかもしれません (監視語を絞ってください)`
          : "",
      },
    });
    return { ...base, fetched: tweets.length, newHits: created.count, truncated, error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prismaInternal.xMentionWatch
      .update({ where: { id: watch.id }, data: { lastCheckedAt: now, lastError: message.slice(0, 500) } })
      .catch(() => {});
    return { ...base, fetched: 0, newHits: 0, truncated: false, error: message };
  }
}

type PendingHit = XMentionHit & { watch: { query: string } };

/**
 * 未通知のヒットを Discord に流す。webhook 未設定なら何もしない (notifiedAt は立てない。
 * 設定した後の初回で溜まっていた分が流れるが、それは「保存はしていた」という意味で正しい)。
 *
 * cron と「今すぐ実行」が重なっても二重に送らないよう、送る前に notifiedAt を立てて行を確保し、
 * 確保できなかった (= 別の実行が先に取った) ツイートは飛ばす。送信に失敗したら確保を戻す
 */
async function notifyPending(): Promise<{ notified: number; remaining: number; notifyError: string | null }> {
  const url = process.env.DISCORD_MENTION_WEBHOOK_URL?.trim();
  if (!url) return { notified: 0, remaining: 0, notifyError: null };

  const pending: PendingHit[] = await prismaInternal.xMentionHit.findMany({
    where: { notifiedAt: null, classification: { in: [...NOTIFIABLE_CLASSIFICATIONS] } },
    include: { watch: { select: { query: true } } },
    orderBy: [{ tweetedAt: "asc" }, { createdAt: "asc" }],
  });
  if (pending.length === 0) return { notified: 0, remaining: 0, notifyError: null };

  // 同じツイートが複数の監視語に当たった分は 1 通にまとめる
  const groups = new Map<string, PendingHit[]>();
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
  let sent = 0;
  let first = true;
  const entries = [...groups.entries()];
  for (let i = 0; i < entries.length; i++) {
    const [tweetId, hits] = entries[i];
    const ids = hits.map((h) => h.id);
    if (alreadySent.has(tweetId)) {
      await prismaInternal.xMentionHit.updateMany({ where: { id: { in: ids } }, data: { notifiedAt: new Date() } });
      continue;
    }
    if (sent >= MAX_NOTIFY_PER_RUN) {
      return { notified, remaining: entries.length - i, notifyError: null };
    }
    // 行を先に確保する。0 件なら別の実行が先に送っている
    const claimed = await prismaInternal.xMentionHit.updateMany({
      where: { id: { in: ids }, notifiedAt: null },
      data: { notifiedAt: new Date() },
    });
    if (claimed.count === 0) continue;

    if (!first) await new Promise((r) => setTimeout(r, DISCORD_GAP_MS));
    first = false;
    sent += 1;
    try {
      await postDiscordWebhook(url, formatHitMessage(hits[0], hits.map((h) => h.watch.query)));
    } catch (e) {
      await prismaInternal.xMentionHit.updateMany({ where: { id: { in: ids } }, data: { notifiedAt: null } }).catch(() => {});
      return { notified, remaining: entries.length - i, notifyError: e instanceof Error ? e.message : String(e) };
    }
    notified += 1;
  }
  return { notified, remaining: 0, notifyError: null };
}

/**
 * 1 ヒットぶんのメッセージ。URL は裸で置いて Discord にツイートを展開させる。
 * 本文は長ければ切る (展開で全文が見える)。`allowed_mentions` は空なので @ が鳴ることはない
 */
export function formatHitMessage(
  hit: Pick<XMentionHit, "authorUsername" | "authorName" | "text" | "tweetedAt" | "url">,
  queries: string[]
): string {
  const who = hit.authorName ? `${hit.authorName} (@${hit.authorUsername})` : `@${hit.authorUsername}`;
  const when = hit.tweetedAt ? formatDate(hit.tweetedAt, true) : "";
  const text = hit.text.replace(/\s+/g, " ").trim();
  const body = text.length > TEXT_MAX_CHARS ? `${text.slice(0, TEXT_MAX_CHARS)}…` : text;
  return [`🔎 **${queries.join(" / ")}** — ${who}${when ? `　${when}` : ""}`, `> ${body}`, hit.url].join("\n");
}
