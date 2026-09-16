import type { JobRunStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { JOB_RUN_DEDUP_SEC, JOB_RUN_RETENTION_DAYS } from "./types";

/**
 * ハートビート (Job / JobRun) の受け口。REST (`POST /api/v1/jobs/{key}/runs`) から呼ぶ。
 * Job / JobRun は非保護テーブルなので素の `prisma`。
 */

/** 報告側が名乗る key。`bot.blog_watch` / `worker.stats` のような小文字・ドット区切り */
export const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export const JobRunRequestSchema = z
  .object({
    status: z.enum(["ok", "error"]),
    message: z.string().max(2000).optional(),
    count: z.number().int().min(0).optional(),
    durationMs: z.number().int().min(0).optional(),
    /** 実行間隔 (秒)。途絶の判定に使う。報告のたびに送ってよい (最新の申告で上書き) */
    intervalSec: z.number().int().min(1).max(86_400 * 31).optional(),
    /** 表示名。初回の報告で無ければ key をそのまま使う */
    name: z.string().min(1).max(100).optional(),
  })
  .strict();

export type JobRunRequest = z.infer<typeof JobRunRequestSchema>;

export interface RecordJobRunResult {
  job: { key: string; name: string; intervalSec: number | null; lastRunAt: Date; lastOkAt: Date | null; lastStatus: JobRunStatus };
  /** JobRun 行を作ったか (ok / count=0 の連続は作らない) */
  recorded: boolean;
}

/**
 * 1 回の実行結果を記録する。
 *
 * - Job が無ければ作る (初回の報告で自動登録)。同じ key の同時報告で片方が unique 違反に
 *   ならないよう upsert
 * - `lastRunAt` は常に進める。`lastOkAt` は ok のときだけ
 * - ok で件数の無い報告は、**最新の JobRun 行**から `JOB_RUN_DEDUP_SEC` 以内なら行を増やさない
 *   (blog_watch は 60 秒 poll なので、そのまま入れると 1 日 1,440 行になる。最後の報告時刻を
 *   基準にすると永久にまとまって 1 行も増えないので、行の時刻を基準にして 1 時間に 1 行残す)。
 *   error と「何かを処理した ok」は毎回残す
 */
export async function recordJobRun(key: string, input: JobRunRequest, now: Date = new Date()): Promise<RecordJobRunResult> {
  return prisma.$transaction(async (tx) => {
    const job = await tx.job.upsert({
      where: { key },
      create: { key, name: input.name ?? key, intervalSec: input.intervalSec ?? null },
      update: {},
    });

    const quiet = input.status === "ok" && !input.count;
    let recentlyQuiet = false;
    if (quiet && job.lastStatus === "ok") {
      // 直前の行も静かな ok だったときだけまとめる (error の直後の ok は「復旧」として残す)
      const latest = await tx.jobRun.findFirst({
        where: { jobId: job.id },
        orderBy: { createdAt: "desc" },
        select: { status: true, count: true, createdAt: true },
      });
      recentlyQuiet =
        latest?.status === "ok" && !latest.count && now.getTime() - latest.createdAt.getTime() < JOB_RUN_DEDUP_SEC * 1000;
    }

    if (!recentlyQuiet) {
      await tx.jobRun.create({
        data: {
          jobId: job.id,
          status: input.status,
          message: input.message ?? "",
          count: input.count ?? null,
          durationMs: input.durationMs ?? null,
          createdAt: now,
        },
      });
    }

    const updated = await tx.job.update({
      where: { id: job.id },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.intervalSec != null ? { intervalSec: input.intervalSec } : {}),
        lastRunAt: now,
        lastStatus: input.status,
        lastMessage: input.message ?? "",
        ...(input.status === "ok" ? { lastOkAt: now } : {}),
      },
    });
    return {
      job: {
        key: updated.key,
        name: updated.name,
        intervalSec: updated.intervalSec,
        lastRunAt: updated.lastRunAt ?? now,
        lastOkAt: updated.lastOkAt,
        lastStatus: updated.lastStatus ?? input.status,
      },
      recorded: !recentlyQuiet,
    };
  });
}

/** 保持期間を過ぎた JobRun を消す (cron から呼ぶ)。消した行数を返す */
export async function pruneJobRuns(now: Date = new Date()): Promise<number> {
  const before = new Date(now.getTime() - JOB_RUN_RETENTION_DAYS * 86_400_000);
  const r = await prisma.jobRun.deleteMany({ where: { createdAt: { lt: before } } });
  return r.count;
}

/** /status のジョブ一覧。直近の履歴を各ジョブに付ける */
export async function listJobsWithRuns(runsPerJob = 10) {
  return prisma.job.findMany({
    orderBy: { key: "asc" },
    include: { runs: { orderBy: { createdAt: "desc" }, take: runsPerJob } },
  });
}
