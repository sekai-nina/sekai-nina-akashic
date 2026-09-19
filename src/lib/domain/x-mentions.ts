import type { XMentionWatch } from "@prisma/client";
import { prisma, withClearance } from "@/lib/db";
import { JOB_KEY, SETTING_ID, normalizeWatchQuery, parseUsernames } from "@/lib/x-mentions/query";

/**
 * X 言及監視 (/mentions) のドメイン層。監視語・除外ユーザー・ヒット一覧の読み書き。
 *
 * XMentionWatch / XMentionSetting / XMentionHit は RLS 有効 (direct-classification)。
 * owner ベースは無いので withClearance で十分。実行そのものは `src/lib/x-mentions/run.ts`
 * (cron と同じ処理をセッション外で走らせる)。定数と純関数は `src/lib/x-mentions/query.ts`
 * (クライアント部品からも import できる leaf module)。
 */

export interface WatchView {
  id: string;
  query: string;
  enabled: boolean;
  lastTweetId: string | null;
  lastCheckedAt: string | null;
  lastError: string;
  hitCount: number;
}

export interface HitView {
  id: string;
  watchQuery: string;
  tweetId: string;
  authorUsername: string;
  authorName: string;
  text: string;
  tweetedAt: string | null;
  url: string;
  notifiedAt: string | null;
}

export interface LastRunView {
  at: string;
  ok: boolean;
  message: string;
}

function toWatchView(w: XMentionWatch & { _count: { hits: number } }): WatchView {
  return {
    id: w.id,
    query: w.query,
    enabled: w.enabled,
    lastTweetId: w.lastTweetId,
    lastCheckedAt: w.lastCheckedAt?.toISOString() ?? null,
    lastError: w.lastError,
    hitCount: w._count.hits,
  };
}

export async function listWatches(clearance: string): Promise<WatchView[]> {
  const rows = await withClearance(clearance, (tx) =>
    tx.xMentionWatch.findMany({ orderBy: { createdAt: "asc" }, include: { _count: { select: { hits: true } } } })
  );
  return rows.map(toWatchView);
}

export async function createWatch(rawQuery: string, clearance: string): Promise<string> {
  const query = normalizeWatchQuery(rawQuery);
  const row = await withClearance(clearance, (tx) => tx.xMentionWatch.create({ data: { query } }));
  return row.id;
}

export async function updateWatch(
  id: string,
  patch: { query?: string; enabled?: boolean },
  clearance: string
): Promise<void> {
  const data: { query?: string; enabled?: boolean } = {};
  if (patch.query !== undefined) data.query = normalizeWatchQuery(patch.query);
  if (patch.enabled !== undefined) data.enabled = patch.enabled;
  if (Object.keys(data).length === 0) return;
  // RLS で見えない行は updateMany が 0 件になるだけ (update だと P2025 で落ちる)
  const r = await withClearance(clearance, (tx) => tx.xMentionWatch.updateMany({ where: { id }, data }));
  if (r.count === 0) throw new Error("監視語が見つかりません");
}

export async function deleteWatch(id: string, clearance: string): Promise<void> {
  const r = await withClearance(clearance, (tx) => tx.xMentionWatch.deleteMany({ where: { id } }));
  if (r.count === 0) throw new Error("監視語が見つかりません");
}

export async function getExcludedUsernames(clearance: string): Promise<string[]> {
  const row = await withClearance(clearance, (tx) => tx.xMentionSetting.findUnique({ where: { id: SETTING_ID } }));
  return row?.excludedUsernames ?? [];
}

/**
 * 除外ユーザーを丸ごと置き換える。入力は改行・カンマ区切りの生文字列。
 * 形の違うものが混ざっていたら保存せずに Error で指摘する (黙って落とすと気づけない)
 */
export async function setExcludedUsernames(input: string, clearance: string, userId: string): Promise<string[]> {
  const { usernames, invalid } = parseUsernames(input);
  if (invalid.length) throw new Error(`ユーザー名の形が違います: ${invalid.join(", ")}`);
  await withClearance(clearance, (tx) =>
    tx.xMentionSetting.upsert({
      where: { id: SETTING_ID },
      create: { id: SETTING_ID, excludedUsernames: usernames, updatedById: userId },
      update: { excludedUsernames: usernames, updatedById: userId },
    })
  );
  return usernames;
}

export async function listRecentHits(clearance: string, limit = 100): Promise<HitView[]> {
  const rows = await withClearance(clearance, (tx) =>
    tx.xMentionHit.findMany({
      orderBy: [{ tweetedAt: "desc" }, { createdAt: "desc" }],
      take: limit,
      include: { watch: { select: { query: true } } },
    })
  );
  return rows.map((h) => ({
    id: h.id,
    watchQuery: h.watch.query,
    tweetId: h.tweetId,
    authorUsername: h.authorUsername,
    authorName: h.authorName,
    text: h.text,
    tweetedAt: h.tweetedAt?.toISOString() ?? null,
    url: h.url,
    notifiedAt: h.notifiedAt?.toISOString() ?? null,
  }));
}

/** 直近の実行 (ハートビート)。Job は非保護テーブルなので素の prisma */
export async function getLastRun(): Promise<LastRunView | null> {
  const job = await prisma.job.findUnique({ where: { key: JOB_KEY } });
  if (!job?.lastRunAt) return null;
  return { at: job.lastRunAt.toISOString(), ok: job.lastStatus === "ok", message: job.lastMessage };
}
