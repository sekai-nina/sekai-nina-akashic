/**
 * 今日の発見の下書きを Claude に頼む (#432)。DB は触らない (呼び出しは `src/lib/domain/discoveries.ts`)。
 *
 * - **外部に出すものは呼び出し側が `MAX_EXTERNAL_AI_CLEARANCE` 以下に絞ってある前提** (`docs/security-dev.md`)
 * - 何本かのブログをまとめて 1 回で頼む。材料名の揃え方が回をまたいでぶれにくく、システムプロンプトも 1 回で済む
 * - 費用は呼び出し側が `recordUsage` で `/costs` に自己申告する
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import {
  CategorizeResponseSchema,
  DraftResponseSchema,
  buildCategorizePrompt,
  buildDraftPrompt,
  type CategorizeResponse,
  type DraftResponse,
  type DraftSource,
} from "./core";

/** 下書きのモデル。ブログ 20 本で入力 5,000・出力 3,000 トークン程度 ($0.1 ほど) */
export const DISCOVERY_AI_MODEL = "claude-opus-5-5";

/** `/costs` の内訳に出る機能名 */
export const DISCOVERY_AI_FEATURE = "akashic.discovery";

/** 1 回に頼むブログの本数の上限 */
export const DISCOVERY_BATCH_SIZE = 20;

/** 1 回に分類を頼む名前の数の上限 */
export const FOOD_BATCH_SIZE = 200;

/** 出力の上限。思考も合わせてこの枠で数えられるので、20 本ぶんの JSON に余裕を取る */
const MAX_OUTPUT_TOKENS = 16_000;
/** 1 回の呼び出しの時間の上限の既定 (CLI)。cron は `ClaudeCallOptions.timeoutMs` で短くする。リトライは 1 回 */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface ClaudeCallOptions {
  /** 1 回の呼び出しの時間の上限。リトライが 1 回あるので、最悪この 2 倍かかる */
  timeoutMs?: number;
}

export class DiscoveryAiError extends Error {
  constructor(
    message: string,
    /** ほかのブログでも同じ結果になる (キーの誤り・レート制限)。呼び出し側はその回を打ち切る */
    readonly stopBatch = false,
  ) {
    super(message);
  }
}

export function isDiscoveryAiConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export interface CallUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface DraftCallResult {
  response: DraftResponse;
  model: string;
  usage: CallUsage;
}

export interface CategorizeCallResult {
  response: CategorizeResponse;
  model: string;
  usage: CallUsage;
}

/** ブログ何本かの下書きを 1 回で頼む。失敗は `DiscoveryAiError` (API の生のエラーはログにだけ残す) */
export async function draftDiscoveriesWithClaude(
  sources: DraftSource[],
  vocabulary: string[],
  opts: ClaudeCallOptions = {},
): Promise<DraftCallResult> {
  if (sources.length > DISCOVERY_BATCH_SIZE) throw new Error(`1 回に頼めるのは ${DISCOVERY_BATCH_SIZE} 本までです`);
  return callStructured(DraftResponseSchema, buildDraftPrompt(sources, vocabulary), opts);
}

/** 食べ物の名前の分類を 1 回で頼む */
export async function categorizeFoodsWithClaude(names: string[], opts: ClaudeCallOptions = {}): Promise<CategorizeCallResult> {
  if (names.length > FOOD_BATCH_SIZE) throw new Error(`1 回に頼めるのは ${FOOD_BATCH_SIZE} 個までです`);
  return callStructured(CategorizeResponseSchema, buildCategorizePrompt(names), opts);
}

async function callStructured<S extends z.ZodType>(
  schema: S,
  prompt: { system: string; user: string },
  opts: ClaudeCallOptions,
): Promise<{ response: z.infer<S>; model: string; usage: CallUsage }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new DiscoveryAiError("ANTHROPIC_API_KEY が未設定です", true);

  const client = new Anthropic({ apiKey, timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxRetries: 1 });
  let response;
  try {
    response = await client.beta.messages.parse({
      model: DISCOVERY_AI_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      // 分類と抜き出しなので深く考えさせなくてよい
      output_config: { effort: "low", format: zodOutputFormat(schema) },
      // 安全分類器が誤って断ったときに、別のモデルでやり直させる
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: prompt.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: prompt.user }],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) {
      throw new DiscoveryAiError("Claude のレート制限に当たりました。少し待ってからやり直してください", true);
    }
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      throw new DiscoveryAiError("Claude の API キーが無効です", true);
    }
    if (e instanceof Anthropic.APIError) {
      console.error("[discoveries/llm] Anthropic error", e.status, e.message);
      throw new DiscoveryAiError(`下書きに失敗しました (${e.status ?? "network"})`);
    }
    // `parse` は返答が JSON として読めない (max_tokens で切れた等) と AnthropicError を投げる
    if (e instanceof Anthropic.AnthropicError) {
      console.error("[discoveries/llm] parse error", e.message);
      throw new DiscoveryAiError("下書きの結果を読み取れませんでした (途中で切れたか、形式が違います)");
    }
    throw e;
  }

  if (response.stop_reason === "refusal") throw new DiscoveryAiError("Claude が下書きを断りました");
  if (response.stop_reason === "max_tokens") throw new DiscoveryAiError("出力が上限に達して途中で切れました");
  const parsed = response.parsed_output;
  if (!parsed) throw new DiscoveryAiError("下書きの結果を読み取れませんでした");

  return {
    response: parsed as z.infer<S>,
    model: response.model,
    usage: {
      // キャッシュへの書き込みは input に足す (単価表に書き込みの単価は無い。少し安く見積もる)
      inputTokens: response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0),
      cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
      outputTokens: response.usage.output_tokens,
    },
  };
}
