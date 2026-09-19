import type { LlmProvider, LlmUsageSource } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { addDaysToDateString, isValidDateString, toJstDateOnly } from "@/lib/utils";
import { computeCostUsd } from "./pricing";

/**
 * 自己申告の利用量を受け取って日次に積む。REST (`POST /api/v1/usage`) と
 * akashic 内部の呼び出し (口コミ抽出) が同じ関数を通る。
 * LlmUsageDaily は非保護テーブルなので素の `prisma`。
 */

/** 呼び出し元の識別子。`<出所>.<機能>` で揃える (akashic.testimonials / bot.discovery など) */
export const FEATURE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

/** INT4 の上限に収める (超えると Postgres が out of range で落ちる) */
const TOKEN_MAX = 2_000_000_000;

/** 遡って報告してよい日数。これより古い / 未来の日付は受け取らない */
export const BACKDATE_MAX_DAYS = 90;

const tokenCount = z.number().int().min(0).max(TOKEN_MAX);

export const UsageReportSchema = z
  .object({
    provider: z.enum(["openai", "anthropic", "google"]),
    model: z.string().trim().min(1).max(100),
    feature: z.string().regex(FEATURE_PATTERN, "feature must match ^[a-z0-9][a-z0-9_.:-]{0,63}$"),
    inputTokens: tokenCount.optional(),
    cachedInputTokens: tokenCount.optional(),
    outputTokens: tokenCount.optional(),
    requests: z.number().int().min(0).max(1_000_000).optional(),
    /**
     * JST の暦日。省略時は今日 (JST)。過去分をまとめて入れるときだけ指定する。
     * **暦に無い日付 (2026-02-30) は 400。** 素の正規表現だけだと Date が 3/2 に繰り上げて
     * 別の日に積まれる。未来と 90 日より前も受け取らない (残高の推定を壊せてしまうため)
     */
    date: z.string().refine(isValidDateString, "date must be a real calendar date (YYYY-MM-DD)").optional(),
  })
  .strict();

export type UsageReport = z.infer<typeof UsageReportSchema>;

/** JST の「YYYY-MM-DD」を DATE 列に入れる値 (UTC 00:00 格納規約) に直す */
export function jstDateOnlyToColumn(dateOnly: string): Date {
  return new Date(`${dateOnly}T00:00:00.000Z`);
}

/** 日付が範囲外 (未来・古すぎる)。route が 400 にする */
export class UsageDateError extends Error {}

export interface RecordUsageResult {
  date: string;
  /** 今回の分の金額。単価表に無いモデルなら null */
  costUsd: number | null;
  /** 単価表に無かった (= 金額を出せなかった) */
  unpriced: boolean;
}

/**
 * 1 回分 (またはまとめた分) の利用量を日次行に加算する。
 *
 * 金額はトークン数に対して線形なので、行の金額も**差分を足す**だけでよい。
 * 単価表に無いモデルは金額を null のままにして、トークンだけ積む
 * (SQL の NULL + x は NULL なので、一度 null になった行は null のまま = 「不明」が伝播する)。
 */
export async function recordUsage(
  input: UsageReport,
  opts: { source?: LlmUsageSource; now?: Date } = {},
): Promise<RecordUsageResult> {
  const now = opts.now ?? new Date();
  const source = opts.source ?? "reported";
  const today = toJstDateOnly(now)!;
  const dateOnly = input.date ?? today;
  if (dateOnly > today) throw new UsageDateError("未来の日付は受け取れません");
  if (dateOnly < addDaysToDateString(today, -BACKDATE_MAX_DAYS)) {
    throw new UsageDateError(`${BACKDATE_MAX_DAYS} 日より前の日付は受け取れません`);
  }
  const date = jstDateOnlyToColumn(dateOnly);

  const inputTokens = input.inputTokens ?? 0;
  const cachedInputTokens = input.cachedInputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  const requests = input.requests ?? 1;

  const provider = input.provider as LlmProvider;
  const costUsd = computeCostUsd(provider, input.model, { inputTokens, cachedInputTokens, outputTokens });

  await prisma.llmUsageDaily.upsert({
    where: {
      date_provider_model_feature_source: { date, provider, model: input.model, feature: input.feature, source },
    },
    create: {
      date,
      provider,
      model: input.model,
      feature: input.feature,
      source,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      requests,
      costUsd,
    },
    update: {
      inputTokens: { increment: inputTokens },
      cachedInputTokens: { increment: cachedInputTokens },
      outputTokens: { increment: outputTokens },
      requests: { increment: requests },
      ...(costUsd == null ? {} : { costUsd: { increment: costUsd } }),
    },
  });

  return { date: dateOnly, costUsd, unpriced: costUsd == null };
}

/**
 * プロバイダの usage API から取り込んだ分を**置き換える** (同じ日を何度取り込んでも二重に積まない)。
 * 自己申告 (source=reported) の行には触らない。
 */
export async function replaceProviderUsage(
  dateOnly: string,
  provider: LlmProvider,
  rows: { model: string; feature: string; inputTokens: number; cachedInputTokens: number; outputTokens: number; requests: number }[],
): Promise<number> {
  const date = jstDateOnlyToColumn(dateOnly);
  return prisma.$transaction(async (tx) => {
    await tx.llmUsageDaily.deleteMany({ where: { date, provider, source: "provider" } });
    // (model, feature) は一意キーの一部。ANTHROPIC_KEY_FEATURES で複数のキーに同じ名前を
    // 付けると衝突して createMany ごと落ちるので、先に足し合わせる
    const merged = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const k = `${r.model}\u0000${r.feature}`;
      const prev = merged.get(k);
      if (!prev) {
        merged.set(k, { ...r });
        continue;
      }
      prev.inputTokens += r.inputTokens;
      prev.cachedInputTokens += r.cachedInputTokens;
      prev.outputTokens += r.outputTokens;
      prev.requests += r.requests;
    }
    rows = [...merged.values()];
    if (rows.length === 0) return 0;
    const created = await tx.llmUsageDaily.createMany({
      data: rows.map((r) => ({
        date,
        provider,
        model: r.model,
        feature: r.feature,
        source: "provider" as const,
        inputTokens: r.inputTokens,
        cachedInputTokens: r.cachedInputTokens,
        outputTokens: r.outputTokens,
        requests: r.requests,
        costUsd: computeCostUsd(provider, r.model, r),
      })),
    });
    return created.count;
  });
}

/** プロバイダの costs API から取り込んだ日次金額を upsert する */
export async function upsertProviderCost(
  dateOnly: string,
  provider: LlmProvider,
  amountUsd: number,
  source: string,
): Promise<void> {
  const date = jstDateOnlyToColumn(dateOnly);
  await prisma.llmCostDaily.upsert({
    where: { date_provider: { date, provider } },
    create: { date, provider, amountUsd, source },
    update: { amountUsd, source },
  });
}
