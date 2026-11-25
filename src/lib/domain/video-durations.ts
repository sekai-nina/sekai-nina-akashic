import { prismaInternal } from "@/lib/db";
import { getDriveVideoDuration } from "@/lib/drive";

/** Drive が長さを持っていない動画は、この間隔をあけて、この回数まで問い合わせ直す (処理が遅れているだけのことがある) */
export const DURATION_RETRY_MS = 24 * 60 * 60_000;
export const DURATION_MAX_PROBES = 3;
const CONCURRENCY = 8;

const videoWhere = { kind: "video" as const, storageProvider: "gdrive" as const, storageKey: { not: null } };

/** まだ長さが無く、問い合わせてよい動画。新しい取り込みを先に拾う */
export function durationPendingWhere(now: Date) {
  return {
    ...videoWhere, durationSec: null, durationProbeCount: { lt: DURATION_MAX_PROBES },
    OR: [{ durationProbedAt: null }, { durationProbedAt: { lt: new Date(now.getTime() - DURATION_RETRY_MS) } }],
  };
}

export type FillDurationsResult = { filled: number; missing: number; retry: number; remaining: number; unknown: number };

/**
 * 長さが空の動画を Drive に問い合わせて `Asset.durationSec` を埋める。
 * 全体の動画が対象なので RLS をバイパスする `prismaInternal` を使う (長さは機密を含まない)。
 * 一時的な失敗は回数に数えず、次の回に拾い直す。
 */
export async function fillVideoDurations({ limit, budgetMs, now = new Date(), apply = true }: {
  limit: number; budgetMs: number; now?: Date; apply?: boolean;
}): Promise<FillDurationsResult> {
  const startedAt = Date.now();
  const targets = await prismaInternal.asset.findMany({
    where: durationPendingWhere(now),
    orderBy: [{ durationProbedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
    take: limit,
    select: { id: true, storageKey: true },
  });
  const found: { id: string; sec: number }[] = [];
  const missing: string[] = [];
  let retry = 0;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    if (Date.now() - startedAt > budgetMs) { retry += targets.length - i; break; }
    await Promise.all(targets.slice(i, i + CONCURRENCY).map(async (t) => {
      try {
        const d = await getDriveVideoDuration(t.storageKey!);
        if (d === "missing") missing.push(t.id); else found.push({ id: t.id, sec: d });
      } catch (e) {
        retry++;
        console.warn(`[video-durations] ${t.id} を次の回に回す: ${e instanceof Error ? e.message : e}`);
      }
    }));
  }
  if (apply && (found.length || missing.length)) {
    await prismaInternal.$transaction([
      ...found.map((f) => prismaInternal.asset.update({
        where: { id: f.id }, data: { durationSec: f.sec, durationProbedAt: now, durationProbeCount: { increment: 1 } },
      })),
      ...(missing.length ? [prismaInternal.asset.updateMany({
        where: { id: { in: missing } }, data: { durationProbedAt: now, durationProbeCount: { increment: 1 } },
      })] : []),
    ]);
  }
  const [remaining, unknown] = await Promise.all([
    prismaInternal.asset.count({ where: durationPendingWhere(now) }),
    prismaInternal.asset.count({ where: { ...videoWhere, durationSec: null, durationProbeCount: { gte: DURATION_MAX_PROBES } } }),
  ]);
  return { filled: found.length, missing: missing.length, retry, remaining, unknown };
}
