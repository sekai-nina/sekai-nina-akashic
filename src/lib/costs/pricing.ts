import type { LlmProvider } from "@prisma/client";

/**
 * モデルごとの単価表 (USD / 100 万トークン)。**自己申告のトークン数を金額に換算するためだけ**に使う。
 * プロバイダの costs API から来る金額はこの表を通さない (向こうが正)。
 *
 * 出典と確認日:
 *   - OpenAI:    https://developers.openai.com/api/docs/pricing (2026-09-19)
 *   - Anthropic: claude-api スキルの単価表 (2026-06-24 時点のキャッシュ)
 *   - Google:    https://ai.google.dev/gemini-api/docs/pricing (2026-09-19)
 *
 * **表に無いモデルは金額を出さない** (null)。勝手に近いモデルの値を当てると、
 * 「安く出ているから大丈夫」と誤読する。未登録は /costs に警告として出す。
 */

export interface ModelPricing {
  /** 入力 1M トークンあたり USD */
  input: number;
  /** キャッシュ読み出し 1M トークンあたり USD。未指定なら input と同じ (= 高めに見積もる) */
  cachedInput?: number;
  /** 出力 1M トークンあたり USD。埋め込みモデルは 0 */
  output: number;
}

/** Anthropic のキャッシュ読み出しは入力の約 1/10 */
const anthropic = (input: number, output: number, cachedInput = input * 0.1): ModelPricing => ({
  input,
  cachedInput,
  output,
});

export const PRICING: Record<LlmProvider, Record<string, ModelPricing>> = {
  openai: {
    "gpt-4o": { input: 2.5, output: 10 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    "gpt-4.1": { input: 2, output: 8 },
    "gpt-4.1-mini": { input: 0.4, output: 1.6 },
    "gpt-4.1-nano": { input: 0.1, output: 0.4 },
    "gpt-5": { input: 1.25, output: 10 },
    "gpt-5-mini": { input: 0.25, output: 2 },
    "gpt-5-nano": { input: 0.05, output: 0.4 },
    "gpt-5.1": { input: 1.25, output: 10 },
    "gpt-5.2": { input: 1.75, output: 14 },
    "gpt-5.4": { input: 2.5, output: 15 },
    "gpt-5.4-mini": { input: 0.75, output: 4.5 },
    "gpt-5.4-nano": { input: 0.2, output: 1.25 },
    "gpt-5.5": { input: 5, output: 30 },
    "gpt-5.6-terra": { input: 2, output: 12 },
    "gpt-5.6-luna": { input: 0.2, output: 1.2 },
    "gpt-5.6-sol": { input: 4, output: 20 },
    // 画像編集・生成 (meet-greet のラフ案)。**テキスト入力 $5 / 画像入力 $10 と単価が分かれるが、
    // usage API はどちらも input_tokens にまとめて返す**ので、高いほう (画像入力) で見積もる。
    // 実測 (2026-09-19, 入力 43,836 / 出力 12,416): この表で $0.935、OpenAI の確定額は $0.912
    "gpt-image-1": { input: 10, cachedInput: 2.5, output: 40 },
    // 2026-09-24 からのスケッチ生成。テキスト入力 $5 / 画像入力 $8 (キャッシュ $1.25 / $2)。同上の理由で画像入力で見積もる
    "gpt-image-2.5-sunburst": { input: 8, cachedInput: 2, output: 30 },
  },
  anthropic: {
    "claude-opus-5": anthropic(5, 25),
    "claude-opus-4-8": anthropic(5, 25),
    "claude-opus-4-7": anthropic(5, 25),
    "claude-opus-4-6": anthropic(5, 25),
    "claude-sonnet-5": anthropic(2, 10),
    "claude-sonnet-4-6": anthropic(3, 15),
    "claude-haiku-4-5": anthropic(1, 5),
    // Fable のキャッシュ読み出しは $0.25/MTok (1/10 ではない)
    "claude-fable-5": anthropic(10, 50, 0.25),
    "claude-fable-5-1": anthropic(10, 50, 0.25),
  },
  google: {
    // 3.x の値は 2026-12-31 までの料金。年明けに見直す
    "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
    "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
    "gemini-3.5-flash": { input: 1.5, output: 9 },
    "gemini-3.6-flash": { input: 0.75, output: 3.75 },
    "gemini-3.7-flash": { input: 0.75, output: 3.75 },
    "gemini-3.8-flash": { input: 0.75, output: 3.75 },
    "gemini-2.5-flash": { input: 0.3, output: 2.5 },
    "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
    // 埋め込みは入力のみ課金 (テキスト)
    "gemini-embedding-2": { input: 0.2, output: 0 },
  },
};

/** `-20260514` / `-2026-05-14` のような日付スナップショットの接尾辞 */
const DATE_SUFFIX = /^-\d{4}-?\d{2}-?\d{2}$/;

/**
 * モデル名から単価を引く。完全一致 → **日付サフィックスを落としただけ**の一致の順。
 *
 * `claude-sonnet-4-6-20260514` のような日付付き、`models/gemini-3.1-flash-lite` のような
 * 接頭辞付きでも引けるようにする (プロバイダの usage API はこの形で返すことがある)。
 *
 * **任意の前方一致にはしない。** `gpt-5.7` が `gpt-5` に、`claude-opus-5-2` が
 * `claude-opus-5` に当たると、新モデルが古い (たいてい安い) 単価で黙って計上される。
 * 知らないモデルは「価格未登録」として出すほうが安全。
 */
export function findPricing(provider: LlmProvider, model: string): ModelPricing | null {
  const table = PRICING[provider];
  const name = model.replace(/^models\//, "").trim();
  if (table[name]) return table[name];
  const key = Object.keys(table)
    .sort((a, b) => b.length - a.length)
    .find((k) => name.startsWith(k) && DATE_SUFFIX.test(name.slice(k.length)));
  return key ? table[key] : null;
}

export interface TokenCounts {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
}

/** トークン数を USD に換算する。単価表に無いモデルは null (= 金額不明) */
export function computeCostUsd(provider: LlmProvider, model: string, tokens: TokenCounts): number | null {
  const p = findPricing(provider, model);
  if (!p) return null;
  const cachedRate = p.cachedInput ?? p.input;
  const usd =
    (tokens.inputTokens * p.input + (tokens.cachedInputTokens ?? 0) * cachedRate + tokens.outputTokens * p.output) /
    1_000_000;
  // 小数 6 桁で丸める (DB の Decimal(12,6) に合わせる)
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** 単価表に載っているモデル名の一覧 (画面の「価格未登録」の判定に使う) */
export function knownModels(provider: LlmProvider): string[] {
  return Object.keys(PRICING[provider]);
}
