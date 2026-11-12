/**
 * 今日の発見の食べ物ごとのイラストのアイコン (#436)。
 *
 * 作りはミーグリの服装スケッチ (`src/lib/meetgreet/sketch.ts`) に揃える: OpenAI の画像編集 API に
 * **固定の基準画像 1 枚** (6 つの食べ物を描いた画風の見本) を渡し、食べ物の名前ごとに 1 枚描かせる。
 * 直前の生成結果を参照し続けると画風がずれていく (スケッチで実際に起きた) ので、基準は替えない。
 *
 * 背景は透明で受け取り、食べ物の形ぎりぎりで切ってから、長い辺の 12% (片側 6%) の余白を付けて正方形にする
 * (チップや式に入れたとき、はみ出したり大きさがばらついたりしないように)。
 *
 * 純粋な部分 (プロンプト・key) はここに、DB は `src/lib/domain/discovery-icons.ts`。
 */

import { createHash } from "node:crypto";
import sharp from "sharp";
import { getR2PublicUrl, isR2Configured, uploadToR2 } from "@/lib/r2";
import { loadR2Image, SketchConfigError, SketchError, type SketchSourceImage } from "@/lib/meetgreet/sketch";

/** 画風の見本 (J 案。2026-11-12 にユーザーが選んだ)。替えると全部の画風が変わるので替えない */
export const FOOD_ICON_STYLE_REFERENCE_KEY = "discoveries/food-icons/style-reference.png";
const ICON_KEY_PREFIX = "discoveries/food-icons";

/** ミーグリのスケッチと同じモデル。2026-11-12 に 5 枚試し、透明背景・画風の揃い方とも問題なかった */
export const FOOD_ICON_MODEL = "gpt-image-2.5-sunburst";
export const FOOD_ICON_FEATURE = "akashic.discovery_food_icon";
const OPENAI_EDITS_URL = "https://api.openai.com/v1/images/edits";

/** 仕上がりの一辺 (px)。サイトでは最大 48px (式) で出すので、高精細の画面でも足りる */
export const FOOD_ICON_SIZE = 256;
/** 食べ物の形のまわりに足す余白 (長い辺に対する割合。両側の合計) */
const ICON_MARGIN = 0.12;
/** 1 枚の生成の時間の上限。実測は 14〜19 秒 */
const GENERATE_TIMEOUT_MS = 90_000;

/**
 * プロンプト。文面を変えると出来上がりが変わるので、直すときは実際に何枚か作って確かめること。
 * `note` は人が確認ページで書いた直す指示 (作り直しのたびに使い続ける)
 */
export function buildFoodIconPrompt(name: string, categoryLabel: string | null, note = ""): string {
  const lines = [
    "添付の画像は、食べ物アイコンの画風の基準です（6つの食べ物が並んでいます）。",
    "この画風（線の太さ、同系色の少し濃い輪郭線、平らな色の面、1段だけの影、小さな白いハイライト1つ、丸っこい形、やさしい色）をそのまま守って、" +
      `「${name}」のアイコンを1つだけ描いてください。`,
    "",
    `- 「${name}」を1つだけ、正面寄りで中央に大きく描く。小さく表示しても何か一目で分かる形にする`,
    ...(categoryLabel ? [`- 分類は「${categoryLabel}」`] : []),
    "- 皿や器は、その食べ物を表すのに必要なときだけ描く",
    "- 背景は透明",
    "- 顔・手・人物・文字・ロゴ・商品のパッケージは描かない。商品名の食べ物は、ロゴの無い一般的な見た目にする",
    "- 基準画像にある6つの食べ物は描かない",
  ];
  const n = note.trim();
  if (n) lines.push("", "直してほしい点（必ず守る）:", `- ${n}`);
  return lines.join("\n");
}

/** R2 の key。名前は日本語なのでハッシュにし、作り直すたびに別の key にする (CDN の古い画像を掴まない) */
export function foodIconKey(name: string, now: number): string {
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `${ICON_KEY_PREFIX}/${hash}-${now}.webp`;
}

/** 透明な余白を切り、余白 (`ICON_MARGIN`) を付けた正方形の webp にする */
export async function finishFoodIcon(png: Buffer): Promise<Buffer> {
  // 中身が全部透明なら何も描かれていない (trim は全面透明だと元の大きさのまま返す)
  const { channels } = await sharp(png).ensureAlpha().stats();
  if ((channels[3]?.max ?? 0) === 0) throw new SketchError("何も描かれていない画像が返りました");
  const trimmed = await sharp(png).ensureAlpha().trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const meta = await sharp(trimmed).metadata();
  if (!meta.width || !meta.height) throw new SketchError("生成された画像の寸法を読み取れませんでした");
  const side = Math.round(Math.max(meta.width, meta.height) * (1 + ICON_MARGIN));
  const left = Math.floor((side - meta.width) / 2);
  const top = Math.floor((side - meta.height) / 2);
  // sharp は 1 つの処理の中では resize を extend より先に当てるので、余白を付けてから別の処理で縮める
  const padded = await sharp(trimmed)
    .extend({
      left,
      right: side - meta.width - left,
      top,
      bottom: side - meta.height - top,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  return sharp(padded)
    .resize(FOOD_ICON_SIZE, FOOD_ICON_SIZE)
    .webp({ quality: 90, alphaQuality: 90 })
    .toBuffer();
}

/** 基準画像を R2 から読む */
export function loadFoodIconStyle(): Promise<SketchSourceImage> {
  return loadR2Image(FOOD_ICON_STYLE_REFERENCE_KEY, "style-reference.png");
}

interface OpenAIImageResponse {
  data?: { b64_json?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

export interface GeneratedFoodIcon {
  key: string;
  url: string;
}

/**
 * アイコンを 1 枚作って R2 に置き、key を返す。DB には触らない (呼び出し側が持つ)。
 * 機密の判定も呼び出し側 (外部 AI に出してよいブログに出てくる名前だけを渡す)
 */
export async function generateFoodIcon(input: {
  name: string;
  categoryLabel: string | null;
  note?: string;
  /** 基準画像。まとめて作るときは 1 回だけ読んで渡す (`loadFoodIconStyle`)。無ければここで読む */
  style?: SketchSourceImage;
}): Promise<GeneratedFoodIcon> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new SketchConfigError("OPENAI_API_KEY が未設定です");
  if (!isR2Configured()) throw new SketchConfigError("R2 が未設定です (生成した画像を保存できません)");

  const style = input.style ?? (await loadFoodIconStyle());
  const form = new FormData();
  form.append("model", FOOD_ICON_MODEL);
  form.append("prompt", buildFoodIconPrompt(input.name, input.categoryLabel, input.note));
  form.append("size", "1024x1024");
  // high は要らない (256px に縮める)。medium で 1 枚 $0.03 ほど
  form.append("quality", "medium");
  form.append("background", "transparent");
  form.append("output_format", "png");
  form.append("n", "1");
  form.append("image[]", new Blob([new Uint8Array(style.bytes)], { type: style.contentType }), style.filename);

  const res = await fetch(OPENAI_EDITS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as OpenAIImageResponse;
  if (!res.ok) {
    // 本文はキーの一部や組織 ID を含むことがあるので、そのまま画面に出さない
    console.error("[discoveries/icon] OpenAI error", res.status, json.error?.message);
    throw new SketchError(`画像生成に失敗しました (${res.status})`);
  }
  if (json.usage) {
    try {
      // 動的 import: 静的に読むとテストが @/lib/db を巻き込む (sketch.ts と同じ)
      const { recordUsage } = await import("@/lib/costs/usage");
      await recordUsage({
        provider: "openai",
        model: FOOD_ICON_MODEL,
        feature: FOOD_ICON_FEATURE,
        inputTokens: json.usage.input_tokens ?? 0,
        outputTokens: json.usage.output_tokens ?? 0,
        requests: 1,
      });
    } catch (e) {
      console.warn(`[discoveries/icon] 利用量の記録に失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new SketchError("画像が返りませんでした");

  const webp = await finishFoodIcon(Buffer.from(b64, "base64"));
  const key = foodIconKey(input.name, Date.now());
  await uploadToR2(key, webp, "image/webp");
  return { key, url: getR2PublicUrl(key) };
}
