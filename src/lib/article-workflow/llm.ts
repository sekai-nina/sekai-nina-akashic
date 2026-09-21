/**
 * 記事の本文を Claude に書かせる (#171)。
 *
 * テンプレートが組んだプロンプト (`ArticleTemplateDef.prompt`) を送り、Structured Output で
 * `AiDraft` の形に固定して受け取る。**外部に出すものは呼び出し側が `MAX_EXTERNAL_AI_CLEARANCE`
 * 以下に絞ってある前提** (`docs/security-dev.md`)。
 *
 * - システムプロンプト (鉄則・見本・語彙) は毎回同じなので prompt caching を効かせる。
 *   素材 (user) だけ変わる
 * - 費用は `recordUsage` で `/costs` に自己申告する (プロバイダ側の内訳はキー単位なので、
 *   機能名を付けるにはこちらで積む)
 * - キー未設定・API の失敗は `ArticleAiError` で返し、呼び出し側が「骨組みだけ」に落とす
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod";
import type { AiDraft, AiPrompt } from "./templates/types";

/**
 * 本文を書くモデル。鉄則 (他メンバーの感想を書かない・推測で補完しない) を守れるかが全てなので、
 * 安いモデルに落とさない。費用は記事 1 本あたり数十円 (入力 1〜2 万トークン)
 */
export const ARTICLE_AI_MODEL = "claude-opus-5";

/** `/costs` の内訳に出る機能名 */
export const ARTICLE_AI_FEATURE = "akashic.article_body";

/** 本文は長くても数百字。余裕を持たせつつ暴走は止める */
const MAX_OUTPUT_TOKENS = 8_000;

export class ArticleAiError extends Error {}

export function isArticleAiConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/** モデルの返答の形。テンプレートが使わない項目は null で返させる */
const DraftSchema = z.object({
  body: z.string(),
  tags: z.array(z.string()),
  title: z.string().nullable(),
  date: z.string().nullable(),
  date_display: z.string().nullable(),
});

export interface AiUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
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

  const client = new Anthropic({ apiKey });
  let response;
  try {
    response = await client.messages.parse({
      model: ARTICLE_AI_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: [{ type: "text", text: prompt.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: prompt.user }],
      output_config: { format: zodOutputFormat(DraftSchema) },
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
    throw e;
  }

  if (response.stop_reason === "refusal") {
    throw new ArticleAiError("Claude が本文の生成を断りました (素材を見直してください)");
  }
  if (response.stop_reason === "max_tokens") {
    throw new ArticleAiError("本文が長すぎて途中で切れました (素材を減らしてください)");
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new ArticleAiError("本文の生成結果を読み取れませんでした");

  return {
    draft: {
      body: parsed.body,
      tags: parsed.tags,
      title: parsed.title,
      date: parsed.date,
      dateDisplay: parsed.date_display,
    },
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
