import { LlmProvider, type LlmUsageSource } from "@prisma/client";
import { prisma } from "@/lib/db";
import { addDaysToDateString, toJstDateOnly } from "@/lib/utils";
import { findPricing } from "./pricing";
import {
  SNAPSHOT_STALE_DAYS,
  jstDateOnlyToColumn,
  burnRatePerDay,
  daysRemaining,
  estimateBalance,
  judgeCredit,
  type DailyCost,
  type ProviderSummary,
} from "./summary";

/**
 * /costs と /status のチェックが読む集計。DB を触る側 (計算そのものは summary.ts の純粋関数)。
 * LlmUsageDaily / LlmCostDaily / CreditSnapshot は非保護テーブルなので素の `prisma`。
 */

/** 画面と判定が見る日数 */
export const HISTORY_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export const ALL_PROVIDERS: LlmProvider[] = [LlmProvider.openai, LlmProvider.anthropic, LlmProvider.google];

function columnDateToJstDateOnly(d: Date): string {
  // DATE 列は「YYYY-MM-DD の UTC 00:00」で入っているので UTC で切るのが正しい
  return d.toISOString().slice(0, 10);
}

/**
 * 日次の支出。**プロバイダの確定金額 (LlmCostDaily) を優先**し、その日の行が無ければ
 * 自己申告の合計で埋める (Gemini のようにコスト API が無いプロバイダはこちらだけ)。
 *
 * 埋めるのは `source = reported` の行だけ。プロバイダの usage API 由来 (`source = provider`)
 * は同じ日の確定金額と二重に数えることになるので使わない。
 * **0 円の日も残す。** 消さないとバーンレートが「使った日だけの平均」になって跳ね上がる。
 */
export async function getDailyCosts(since: Date): Promise<Map<LlmProvider, DailyCost[]>> {
  const [costRows, usageRows] = await Promise.all([
    prisma.llmCostDaily.findMany({ where: { date: { gte: since } }, orderBy: { date: "asc" } }),
    prisma.llmUsageDaily.groupBy({
      by: ["provider", "date"],
      where: { date: { gte: since }, source: "reported" },
      _sum: { costUsd: true },
    }),
  ]);

  const byProvider = new Map<LlmProvider, Map<string, number>>();
  for (const p of ALL_PROVIDERS) byProvider.set(p, new Map());

  // 先に自己申告で埋め、確定金額で上書きする
  for (const r of usageRows) {
    byProvider.get(r.provider)?.set(columnDateToJstDateOnly(r.date), Number(r._sum.costUsd ?? 0));
  }
  for (const r of costRows) {
    byProvider.get(r.provider)?.set(columnDateToJstDateOnly(r.date), Number(r.amountUsd));
  }

  const out = new Map<LlmProvider, DailyCost[]>();
  for (const [provider, map] of byProvider) {
    out.set(
      provider,
      [...map.entries()].map(([date, usd]) => ({ date, usd })).sort((a, b) => (a.date < b.date ? -1 : 1)),
    );
  }
  return out;
}

/** プロバイダごとの最新の残高スナップショット (全件は引かない) */
export async function getLatestSnapshots(): Promise<Map<LlmProvider, { balanceUsd: number; observedAt: Date }>> {
  const rows = await prisma.creditSnapshot.findMany({
    distinct: ["provider"],
    orderBy: [{ provider: "asc" }, { observedAt: "desc" }],
    select: { provider: true, balanceUsd: true, observedAt: true },
  });
  return new Map(rows.map((r) => [r.provider, { balanceUsd: Number(r.balanceUsd), observedAt: r.observedAt }]));
}

/**
 * 金額を出せていないモデル。2 通りある:
 *   - 行の `costUsd` が null (報告時に単価表に無かった)
 *   - **今の単価表に無い** (キーを消した / 打ち間違えた)。この場合は行に古い金額が残るので
 *     null 判定だけでは気づけず、以降の加算だけが黙って止まる
 */
async function getUnpricedModels(since: Date): Promise<Map<LlmProvider, string[]>> {
  const rows = await prisma.llmUsageDaily.groupBy({
    by: ["provider", "model"],
    where: { date: { gte: since } },
    _min: { costUsd: true },
  });
  const out = new Map<LlmProvider, string[]>();
  for (const p of ALL_PROVIDERS) out.set(p, []);
  for (const r of rows) {
    if (r._min.costUsd == null || findPricing(r.provider, r.model) == null) out.get(r.provider)?.push(r.model);
  }
  return out;
}

/**
 * 全プロバイダのまとめ。
 *
 * 残高は「最新スナップショット − **その日を含む**それ以降の支出」。目視した時点でその日の
 * 支出の一部は既に残高に反映されているので二重に引くことになるが、**多めに引く方に倒す**。
 * 少なく引くと残高を多く見せ、補充の警告が遅れる (この機能の存在意義を損なう) ため。
 */
export async function getProviderSummaries(now: Date = new Date()): Promise<ProviderSummary[]> {
  const today = toJstDateOnly(now)!;
  const historyStart = addDaysToDateString(today, -HISTORY_DAYS);
  const snapshots = await getLatestSnapshots();

  // **支出を引く窓はスナップショットの古さに合わせて広げる。** 30 日ぶんしか引かないと、
  // 45 日前のスナップショットから 15 日分の支出が消えて残高を多く見せてしまう
  // (judgeCredit が unknown にするのは 60 日を過ぎてからなので、その間ずっと嘘をつく)
  const staleLimit = addDaysToDateString(today, -(SNAPSHOT_STALE_DAYS + 1));
  let spendStart = historyStart;
  for (const s of snapshots.values()) {
    const day = toJstDateOnly(s.observedAt)!;
    if (day < spendStart) spendStart = day;
  }
  if (spendStart < staleLimit) spendStart = staleLimit;

  const [daily, unpriced] = await Promise.all([
    getDailyCosts(jstDateOnlyToColumn(spendStart)),
    getUnpricedModels(jstDateOnlyToColumn(historyStart)),
  ]);

  const monthPrefix = today.slice(0, 7);

  return ALL_PROVIDERS.map((provider) => {
    // costs は残高計算用の広い窓、daily は画面に出す直近 HISTORY_DAYS 日
    const costs = daily.get(provider) ?? [];
    const recent = costs.filter((c) => c.date >= historyStart);
    const snapshot = snapshots.get(provider) ?? null;
    const monthUsd = costs.filter((c) => c.date.startsWith(monthPrefix)).reduce((s, c) => s + c.usd, 0);
    const burnPerDay = burnRatePerDay(costs, today);

    const snapshotDay = snapshot ? toJstDateOnly(snapshot.observedAt)! : null;
    const spentSince = snapshotDay ? costs.filter((c) => c.date >= snapshotDay).reduce((s, c) => s + c.usd, 0) : 0;
    const balanceUsd = estimateBalance({ snapshot, spentSince });
    const snapshotAgeDays = snapshot ? (now.getTime() - snapshot.observedAt.getTime()) / DAY_MS : null;
    const days = daysRemaining(balanceUsd, burnPerDay);

    return {
      provider,
      monthUsd: Math.round(monthUsd * 1_000_000) / 1_000_000,
      daily: recent,
      burnPerDay,
      balanceUsd,
      snapshotAt: snapshot?.observedAt ?? null,
      snapshotAgeDays,
      days,
      judgement: judgeCredit({ balanceUsd, burnPerDay, snapshotAgeDays, days }),
      unpricedModels: unpriced.get(provider) ?? [],
    };
  });
}

export interface FeatureBreakdownRow {
  provider: LlmProvider;
  feature: string;
  model: string;
  /** reported = 自己申告 / provider = プロバイダの usage API。**足し合わせない** (同じ利用を二重に数える) */
  source: LlmUsageSource;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface FeatureTotalRow {
  feature: string;
  provider: LlmProvider;
  source: LlmUsageSource;
  requests: number;
  costUsd: number | null;
}

/**
 * 機能ごとの合計 (直近 `HISTORY_DAYS` 日)。「何にいくらかかったか」の一次回答。
 * **自己申告とプロバイダ由来は分けたまま**足さない (同じ利用が両方に出る)。
 */
export async function getFeatureTotals(now: Date = new Date()): Promise<FeatureTotalRow[]> {
  const since = jstDateOnlyToColumn(addDaysToDateString(toJstDateOnly(now)!, -HISTORY_DAYS));
  const rows = await prisma.llmUsageDaily.groupBy({
    by: ["feature", "provider", "source"],
    where: { date: { gte: since } },
    _sum: { requests: true, costUsd: true },
  });
  return rows
    .map((r) => ({
      feature: r.feature,
      provider: r.provider,
      source: r.source,
      requests: r._sum.requests ?? 0,
      costUsd: r._sum.costUsd == null ? null : Number(r._sum.costUsd),
    }))
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
}

/** 機能 × モデルの内訳 (直近 `HISTORY_DAYS` 日)。金額の降順 */
export async function getFeatureBreakdown(now: Date = new Date()): Promise<FeatureBreakdownRow[]> {
  // DATE 列に実時刻を当てると当日の時刻ぶんだけ窓がずれる (一番古い日が出たり消えたりする)
  const since = jstDateOnlyToColumn(addDaysToDateString(toJstDateOnly(now)!, -HISTORY_DAYS));
  const rows = await prisma.llmUsageDaily.groupBy({
    by: ["provider", "feature", "model", "source"],
    where: { date: { gte: since } },
    _sum: { requests: true, inputTokens: true, cachedInputTokens: true, outputTokens: true, costUsd: true },
  });
  return rows
    .map((r) => ({
      provider: r.provider,
      feature: r.feature,
      model: r.model,
      source: r.source,
      requests: r._sum.requests ?? 0,
      inputTokens: (r._sum.inputTokens ?? 0) + (r._sum.cachedInputTokens ?? 0),
      outputTokens: r._sum.outputTokens ?? 0,
      costUsd: r._sum.costUsd == null ? null : Number(r._sum.costUsd),
    }))
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
}
