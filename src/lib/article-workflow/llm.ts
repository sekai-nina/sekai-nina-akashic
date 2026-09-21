/**
 * 記事の本文を Claude に書かせる (#171)。
 *
 * テンプレートが組んだプロンプト (`ArticleTemplateDef.prompt`) を送り、Structured Output で
 * `AiDraft` の形に固定して受け取る。**外部に出すものは呼び出し側が `MAX_EXTERNAL_AI_CLEARANCE`
 * 以下に絞ってある前提** (`docs/security-dev.md`)。
 *
 * - システムプロンプト (鉄則・見本・語彙) は毎回ほぼ同じなので prompt caching を効かせる。
 *   ブロックごとに区切り、語彙 (記事を保存すると変わる) が変わっても鉄則・見本のキャッシュは残す
 * - 費用は呼び出し側が `recordUsage` で `/costs` に自己申告する
 * - キー未設定・API の失敗・返答の形が読めないときは `ArticleAiError` で返し、呼び出し側が
 *   「骨組みだけ」に落とす
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { AiDraftSchema, clampAiDraft, type AiDraft, type AiPrompt, type AiUsage } from "./templates/types";

/**
 * 本文を書くモデル。鉄則 (他メンバーの感想を書かない・推測で補完しない) を守れるかが全てなので、
 * 安いモデルに落とさない。費用は記事 1 本あたり数十円 (素材 8 万字の上限まで入れると $0.4 程度)
 */
export const ARTICLE_AI_MODEL = "claude-opus-5";

/** `/costs` の内訳に出る機能名 */
export const ARTICLE_AI_FEATURE = "akashic.article_body";

/**
 * 出力の上限。**思考 (adaptive thinking) も本文と合わせてこの枠で数えられる**ので、本文は数百字でも
 * 余裕を取る。足りないと思考の途中で切れて「本文が長すぎる」に見える
 */
const MAX_OUTPUT_TOKENS = 16_000;

/** 画面の `maxDuration` (300s) の中で必ず結果を返す。リトライは 1 回 */
const TIMEOUT_MS = 180_000;

export class ArticleAiError extends Error {}

export function isArticleAiConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export interface GeneratedDraft {
  draft: AiDraft;
  model: string;
  usage: AiUsage;
}

/**
 * 下書きを 1 回生成する。失敗は `ArticleAiError` (文言は画面に出してよいものだけ。
 * API の生のエラーはキーの一部を含むことがあるのでログにだけ残す)
 */
export async function generateArticleDraft(prompt: AiPrompt): Promise<GeneratedDraft> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new ArticleAiError("ANTHROPIC_API_KEY が未設定です");

  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  let response;
  try {
    response = await client.messages.parse({
      model: ARTICLE_AI_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: prompt.system.map((text) => ({
        type: "text" as const,
        text,
        cache_control: { type: "ephemeral" as const },
      })),
      messages: [{ role: "user", content: prompt.user }],
      output_config: { format: zodOutputFormat(AiDraftSchema) },
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) {
      throw new ArticleAiError("Claude のレート制限に当たりました。少し待ってからやり直してください");
    }
    if (e instanceof Anthropic.AuthenticationError) {
      throw new ArticleAiError("Claude の API キーが無効です");
    }
    if (e instanceof Anthropic.APIError) {
      console.error("[article-workflow/llm] Anthropic error", e.status, e.message);
      throw new ArticleAiError(`本文の生成に失敗しました (${e.status ?? "network"})`);
    }
    // `parse` は返答が JSON として読めない (max_tokens で切れた等) と AnthropicError を投げる
    if (e instanceof Anthropic.AnthropicError) {
      console.error("[article-workflow/llm] parse error", e.message);
      throw new ArticleAiError("本文の生成結果を読み取れませんでした (途中で切れたか、形式が違います)");
    }
    throw e;
  }

  if (response.stop_reason === "refusal") {
    throw new ArticleAiError("Claude が本文の生成を断りました (素材を見直してください)");
  }
  if (response.stop_reason === "max_tokens") {
    throw new ArticleAiError("出力が上限に達して途中で切れました (素材を減らしてください)");
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new ArticleAiError("本文の生成結果を読み取れませんでした");
  if (!parsed.body.trim()) throw new ArticleAiError("Claude が本文を書きませんでした (素材に書けることが無かったようです)");

  return {
    draft: clampAiDraft(parsed),
    model: response.model,
    usage: {
      // キャッシュへの書き込み (初回) は input と別に数えられる。単価表に書き込みの単価は無いので
      // input に足す (実際は 1.25 倍。少し安く見積もることになる)
      inputTokens: response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0),
      cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
      outputTokens: response.usage.output_tokens,
    },
  };
}
