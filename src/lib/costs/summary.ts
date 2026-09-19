import type { Currency } from "./currency";
import type { LlmProvider, StatusLevel } from "@prisma/client";
import { addDaysToDateString } from "@/lib/utils";

/**
 * 残高・バーンレート・残り日数の計算。**DB を触らない純粋関数**だけを置く
 * (閾値の境界を vitest で固定するため)。DB から引く側は `src/lib/costs/report.ts`。
 */

/** 残り日数がこれを下回ったら注意 / 異常 */
export const CREDIT_WARN_DAYS = 14;
export const CREDIT_ERROR_DAYS = 7;

/** 残高スナップショットがこれより古ければ「当てにならない」とみなす */
export const SNAPSHOT_STALE_DAYS = 60;

/** バーンレートを平均する日数 */
export const BURN_WINDOW_DAYS = 7;

export interface DailyCost {
  /** JST の暦日 (YYYY-MM-DD) */
  date: string;
  usd: number;
}

/**
 * JST の「YYYY-MM-DD」を DATE 列に入れる値 (UTC 00:00 格納規約) に直す。
 *
 * **純粋関数なのでここに置く。** DB を触るモジュール (usage.ts) に置くと、これを使う
 * テストが `@/lib/db` を読み込み、DATABASE_URL の無い CI で PrismaClient の生成に失敗する。
 */
export function jstDateOnlyToColumn(dateOnly: string): Date {
  return new Date(`${dateOnly}T00:00:00.000Z`);
}

/** 「YYYY-MM-DD」どうしの日数差 (a から b まで、b は含めない) */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * 直近 `BURN_WINDOW_DAYS` 日の 1 日あたり平均支出。
 *
 * **支出のあった日だけで割らない。** 記録が無い日も 0 として数えるため、合計を
 * **暦日数**で割る (行数で割ると、週に 1 回しか動かない処理でバーンレートが 7 倍に出て
 * 「あと 1 日」と誤報する)。当日 (`today`) は途中経過なので除く。
 * 記録を取り始めて間もないときは、最初の記録からの日数で割る (0 の日を捏造しない)。
 */
export function burnRatePerDay(costs: DailyCost[], today: string, windowDays = BURN_WINDOW_DAYS): number {
  const past = costs.filter((c) => c.date < today).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (past.length === 0) return 0;
  const windowStart = addDaysToDateString(today, -windowDays);
  const inWindow = past.filter((c) => c.date >= windowStart);
  if (inWindow.length === 0) return 0;
  // 窓の左端と「最初の記録」の遅いほうから今日までが、実際に観測できている日数
  const spanStart = past[0].date > windowStart ? past[0].date : windowStart;
  const observedDays = Math.max(1, daysBetween(spanStart, today));
  return inWindow.reduce((sum, c) => sum + c.usd, 0) / observedDays;
}

/**
 * `from` から `to` (両端を含む) までの各日を並べ、記録の無い日を 0 で埋める。
 * グラフの横軸を日付で揃えるために使う (記録のある日だけ並べると、たまにしか使わない
 * プロバイダが「毎日使っている」ように見える)。
 */
export function fillMissingDays(costs: DailyCost[], from: string, to: string): DailyCost[] {
  const byDate = new Map(costs.map((c) => [c.date, c.usd]));
  const out: DailyCost[] = [];
  for (let d = from; d <= to; d = addDaysToDateString(d, 1)) {
    out.push({ date: d, usd: byDate.get(d) ?? 0 });
  }
  return out;
}

export interface BalanceInput {
  /** 最新の残高スナップショット。無ければ null */
  snapshot: { balanceUsd: number; observedAt: Date } | null;
  /** スナップショット以降の支出合計 (USD) */
  spentSince: number;
}

/** 推定残高。スナップショットが無ければ null */
export function estimateBalance(input: BalanceInput): number | null {
  if (!input.snapshot) return null;
  return Math.round((input.snapshot.balanceUsd - input.spentSince) * 100) / 100;
}

/** 残り日数。残高不明・バーンレート 0 なら null (= 判定しない) */
export function daysRemaining(balanceUsd: number | null, burnPerDay: number): number | null {
  if (balanceUsd == null || burnPerDay <= 0) return null;
  if (balanceUsd <= 0) return 0;
  return Math.floor(balanceUsd / burnPerDay);
}

export interface CreditJudgement {
  status: StatusLevel;
  /** Discord にも出る 1 行。**金額は入れない** (通知先のチャンネルに口座の残高を流さない) */
  summary: string;
}

export interface CreditJudgeInput {
  balanceUsd: number | null;
  burnPerDay: number;
  /** スナップショットを観測してからの日数。スナップショットが無ければ null */
  snapshotAgeDays: number | null;
  days: number | null;
}

/**
 * 「補充したほうがいいか」の判定。
 *   - スナップショットが無い / 古すぎる → unknown (障害ではなく入力待ち)
 *   - 残り日数が 7 日未満 → error、14 日未満 → warn
 *   - バーンレートが 0 (使っていない) → ok「消費なし」
 */
export function judgeCredit(input: CreditJudgeInput): CreditJudgement {
  const { balanceUsd, burnPerDay, snapshotAgeDays, days } = input;
  if (balanceUsd == null || snapshotAgeDays == null) {
    return { status: "unknown", summary: "残高が未登録 (/costs から現在の残高を入れてください)" };
  }
  if (snapshotAgeDays > SNAPSHOT_STALE_DAYS) {
    return {
      status: "unknown",
      summary: `残高の記録が ${Math.floor(snapshotAgeDays)} 日前で当てになりません (入れ直してください)`,
    };
  }
  if (balanceUsd <= 0) return { status: "error", summary: "推定残高が尽きています (補充してください)" };
  if (burnPerDay <= 0) return { status: "ok", summary: "直近の消費なし" };
  if (days == null) return { status: "unknown", summary: "残り日数を計算できません" };
  if (days < CREDIT_ERROR_DAYS) return { status: "error", summary: `残り約 ${days} 日 (補充してください)` };
  if (days < CREDIT_WARN_DAYS) return { status: "warn", summary: `残り約 ${days} 日` };
  return { status: "ok", summary: `残り約 ${days} 日` };
}

/** /costs と /status のチェックが共有する 1 プロバイダ分のまとめ */
export interface ProviderSummary {
  provider: LlmProvider;
  /** 今月 (JST) の支出 */
  monthUsd: number;
  /** 直近 30 日の日次支出 */
  daily: DailyCost[];
  burnPerDay: number;
  balanceUsd: number | null;
  snapshotAt: Date | null;
  /** 目視した通貨のままの残高。USD 以外で記録されたときに画面へ添える */
  snapshotSource: { amount: number; currency: Currency; unitsPerUsd: number } | null;
  snapshotAgeDays: number | null;
  days: number | null;
  judgement: CreditJudgement;
  /** 金額を出せなかった (単価表に無い) モデル */
  unpricedModels: string[];
}
