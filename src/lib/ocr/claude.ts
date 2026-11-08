/**
 * 画像の OCR を Claude に頼む (#379)。DB は触らない (呼び出しは `src/lib/domain/ocr.ts`)。
 *
 * - **外部に出すものは呼び出し側が `public` / `internal` に絞ってある前提** (文字起こしと同じ)
 * - 画像は長辺 2576px (Claude の高解像度の上限) に収めて JPEG にしてから送る。
 *   これより大きいと API 側で縮められるだけで費用は変わらないが、5 MB の上限に当たるため
 * - 費用は呼び出し側が `recordUsage` で `/costs` に自己申告する
 */

import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";

/**
 * OCR のモデル。雑誌の縦書き・段組み・写真に重なった文字を読むので上位モデルにする。
 * 1 ページ (画像 約 4,800 トークン + 出力 1,000〜2,000 トークン) で $0.03〜0.05 程度
 */
export const OCR_MODEL = "claude-opus-5-5";

/** `/costs` の内訳に出る機能名 */
export const OCR_FEATURE = "akashic.ocr";

/** 長辺の上限。Claude の高解像度画像の上限に合わせる */
const MAX_EDGE_PX = 2576;
/** base64 にする前の上限。API は 1 枚 5 MB まで */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 出力の上限。思考と本文を合わせてこの枠で数えられる。雑誌の文字の多いページでも足りる量 */
const MAX_OUTPUT_TOKENS = 16_000;
/** cron の 1 件・画面のボタンの `maxDuration` に収める */
const TIMEOUT_MS = 120_000;

/** 文字が無い画像のときに返させる印 */
const NO_TEXT = "NO_TEXT";

const SYSTEM_PROMPT = `あなたは画像の文字を書き起こす係です。渡された画像 (主に日本語の雑誌のページ) に写っている文字を、すべてそのまま書き起こしてください。

- 見出し・本文・キャプション・クレジット (撮影・スタイリング等)・ページ番号まで、読める文字はすべて含める
- 読む順番は紙面のとおりにする。縦書きは右の列から左へ、段組みは段ごとにまとめる。まとまり (記事・キャプション) の間は空行で区切る
- 文字は直さない。誤字や表記ゆれもそのまま。ルビは本文の後ろに（）で添える
- 読めない文字は〓にする。推測で補わない
- 説明・前置き・要約は書かない。書き起こした文字だけを出力する
- 文字がまったく無い画像なら ${NO_TEXT} とだけ出力する`;

export class OcrError extends Error {
  constructor(
    message: string,
    /** やり直しても直らない (画像が読めない・大きすぎる・Claude が断った) */
    readonly permanent: boolean,
    /** ほかの画像でも同じ結果になる (キーの誤り・レート制限)。cron はその回を打ち切る */
    readonly stopBatch = false,
  ) {
    super(message);
  }
}

export function isOcrConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export interface OcrResult {
  /** 書き起こした文字。文字が無ければ空 */
  text: string;
  model: string;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
}

/** 長辺を MAX_EDGE_PX に収めた JPEG にする。縦横の向き (EXIF) もここで直す */
async function prepareImage(data: Buffer): Promise<Buffer> {
  let out: Buffer;
  try {
    out = await sharp(data)
      .rotate()
      .resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch (e) {
    throw new OcrError(`画像を読み込めませんでした: ${e instanceof Error ? e.message : e}`, true);
  }
  if (out.length > MAX_IMAGE_BYTES) {
    out = await sharp(out).jpeg({ quality: 75 }).toBuffer();
    if (out.length > MAX_IMAGE_BYTES) throw new OcrError("画像が 5 MB に収まりませんでした", true);
  }
  return out;
}

/**
 * 画像 1 枚を書き起こす。失敗は `OcrError` (文言は画面に出してよいものだけ。
 * API の生のエラーはログにだけ残す)
 */
export async function ocrImageWithClaude(data: Buffer): Promise<OcrResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new OcrError("ANTHROPIC_API_KEY が未設定です", false, true);

  const image = await prepareImage(data);
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  let response;
  try {
    response = await client.beta.messages.create({
      model: OCR_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      // 読み取りは見た目の作業で、考え込ませても精度はあまり上がらない。思考の分の出力を抑える
      output_config: { effort: "low" },
      // 安全分類器が誤って断ったときに、別のモデルでやり直させる
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image.toString("base64") } },
            { type: "text", text: "この画像の文字を書き起こしてください。" },
          ],
        },
      ],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) {
      throw new OcrError("Claude のレート制限に当たりました。少し待ってからやり直してください", false, true);
    }
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      throw new OcrError("Claude の API キーが無効です", false, true);
    }
    if (e instanceof Anthropic.BadRequestError) {
      console.error("[ocr] Anthropic 400", e.message);
      throw new OcrError("Claude が画像を受け付けませんでした", true);
    }
    if (e instanceof Anthropic.APIError) {
      console.error("[ocr] Anthropic error", e.status, e.message);
      throw new OcrError(`OCR に失敗しました (${e.status ?? "network"})`, false);
    }
    throw e;
  }

  if (response.stop_reason === "refusal") throw new OcrError("Claude が書き起こしを断りました", true);
  if (response.stop_reason === "max_tokens") throw new OcrError("出力が上限に達して途中で切れました", true);

  const raw = response.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("")
    .trim();
  return {
    text: raw === NO_TEXT ? "" : raw,
    model: response.model,
    usage: {
      inputTokens: response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0),
      cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
      outputTokens: response.usage.output_tokens,
    },
  };
}
