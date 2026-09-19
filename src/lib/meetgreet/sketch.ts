/**
 * 服装スケッチの生成 (#108)。
 *
 * ドシエで選んだその日の写真と、シリーズの画風をそろえるための「基準スケッチ」を
 * OpenAI の画像編集 API (gpt-image-1) に渡し、候補を 2 枚作って R2 に置く。
 * 人が 1 枚選んで確定するか、修正指示を書いて作り直す。
 *
 * **基準スケッチは固定の 1 枚**（R2 の `STYLE_REFERENCE_KEY`）。直前の生成結果を参照し続けると
 * コピーのコピーで画風が少しずつずれていくため。差し替えは画面から行う。
 */

import sharp from "sharp";
import { downloadFromDrive, isDriveEnabled } from "@/lib/drive";
import { getR2PublicUrl, isR2Configured, uploadToR2 } from "@/lib/r2";
import { MAX_REFERENCE_PHOTOS, SKETCH_CANDIDATE_COUNT } from "./config";
import { buildSketchPrompt } from "./sketch-prompt";

/** 画風の見本。回をまたいで固定で使う */
export const STYLE_REFERENCE_KEY = "meetgreet/style-reference/base.png";

const OPENAI_IMAGE_MODEL = "gpt-image-1";
const OPENAI_EDITS_URL = "https://api.openai.com/v1/images/edits";

/**
 * gpt-image-1 が出せるのは 1024x1024 / 1536x1024 / 1024x1536 の 3 つだけで、
 * プロンプトが求める 1.91:1 は直接出せない。横長の 1536x1024 (1.5:1) で作って、
 * **左右に白を足して** 1.91:1 にする（背景が白指定なので継ぎ目は出ないし、
 * 上下を切る方式と違って描かれたものが欠けない）。
 */
const GENERATED_WIDTH = 1536;
const GENERATED_HEIGHT = 1024;
const TARGET_ASPECT = 1.91;

export interface SketchSourceImage {
  /** ファイル名。拡張子で Content-Type が決まるので必ず付ける */
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export class SketchError extends Error {}

/**
 * アセットの画像バイト列を取る。Drive に原本があればそれを、無ければ R2 のサムネイルを使う
 * (サムネイルは 640px なので、素材感やアクセサリーの再現は落ちる)。
 */
export async function loadAssetImage(asset: {
  id: string;
  title: string;
  storageProvider: string;
  storageKey: string | null;
  thumbnailUrl: string | null;
  mimeType: string | null;
}): Promise<SketchSourceImage | null> {
  if (asset.storageProvider === "gdrive" && asset.storageKey && isDriveEnabled()) {
    const bytes = await downloadFromDrive(asset.storageKey);
    if (bytes) {
      return {
        filename: `${asset.id}.jpg`,
        contentType: asset.mimeType ?? "image/jpeg",
        bytes,
      };
    }
  }
  if (asset.thumbnailUrl) {
    const res = await fetch(asset.thumbnailUrl);
    if (res.ok) {
      return {
        filename: `${asset.id}.webp`,
        contentType: "image/webp",
        bytes: Buffer.from(await res.arrayBuffer()),
      };
    }
  }
  return null;
}

/** 基準スケッチを R2 から取る */
export async function loadStyleReference(key = STYLE_REFERENCE_KEY): Promise<SketchSourceImage> {
  const res = await fetch(getR2PublicUrl(key));
  if (!res.ok) {
    throw new SketchError(`基準スケッチを読めませんでした (${res.status})。R2 の ${key} を確認してください`);
  }
  return {
    filename: "style-reference.png",
    contentType: "image/png",
    bytes: Buffer.from(await res.arrayBuffer()),
  };
}

/**
 * 1536x1024 を左右の白埋めで 1.91:1 にする。
 * 生成物は一切切らないので、頭や補助スケッチが欠けることはない。
 */
export async function padToCardAspect(png: Buffer): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const width = meta.width ?? GENERATED_WIDTH;
  const height = meta.height ?? GENERATED_HEIGHT;
  const targetWidth = Math.round(height * TARGET_ASPECT);
  if (targetWidth <= width) return png; // 既に十分横長なら何もしない

  const pad = targetWidth - width;
  const left = Math.floor(pad / 2);
  return sharp(png)
    .extend({
      left,
      right: pad - left,
      top: 0,
      bottom: 0,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toBuffer();
}

interface OpenAIImageResponse {
  data?: { b64_json?: string }[];
  error?: { message?: string };
}

/**
 * 画像編集 API を 1 回叩いて候補を受け取る。
 *
 * 参照写真 → 基準スケッチ の順に積む（プロンプトが「最後の1枚が基準スケッチ」と
 * 書いているので順番に意味がある）。
 */
async function callOpenAIEdits(
  photos: SketchSourceImage[],
  styleReference: SketchSourceImage,
  prompt: string,
  count: number
): Promise<Buffer[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new SketchError("OPENAI_API_KEY が未設定です");

  const form = new FormData();
  form.append("model", OPENAI_IMAGE_MODEL);
  form.append("prompt", prompt);
  form.append("size", `${GENERATED_WIDTH}x${GENERATED_HEIGHT}`);
  form.append("quality", "high");
  // 服の構造・小物を元写真から拾わせる
  form.append("input_fidelity", "high");
  form.append("n", String(count));
  form.append("output_format", "png");
  for (const img of [...photos, styleReference]) {
    form.append("image[]", new Blob([new Uint8Array(img.bytes)], { type: img.contentType }), img.filename);
  }

  const res = await fetch(OPENAI_EDITS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const json = (await res.json().catch(() => ({}))) as OpenAIImageResponse;
  if (!res.ok) {
    throw new SketchError(`画像生成に失敗しました (${res.status}): ${json.error?.message ?? "不明なエラー"}`);
  }
  const images = (json.data ?? [])
    .map((d) => d.b64_json)
    .filter((b): b is string => !!b)
    .map((b) => Buffer.from(b, "base64"));
  if (images.length === 0) throw new SketchError("画像が返りませんでした");
  return images;
}

export interface GenerateSketchInput {
  meetGreetId: string;
  photos: SketchSourceImage[];
  /** 回ごとの追加指示 (どの髪型を中央にするか等) */
  extraPrompt: string;
  /** 作り直しのとき、直したい候補を参照に足す */
  revisionOf?: SketchSourceImage;
  /** 作り直しの指示 */
  revisionNote?: string;
  count?: number;
  styleReferenceKey?: string;
}

export interface GeneratedSketch {
  key: string;
  url: string;
}

/**
 * 候補を生成して R2 に置き、key を返す。DB には触らない (呼び出し側が持つ)。
 *
 * 作り直しのときは「直したい候補 + 修正指示」を足す。元の参照写真も一緒に渡すので、
 * 服装の情報が落ちない。
 */
export async function generateSketches(input: GenerateSketchInput): Promise<GeneratedSketch[]> {
  if (!isR2Configured()) throw new SketchError("R2 が未設定です (生成した画像を保存できません)");
  if (input.photos.length === 0) throw new SketchError("参照にする写真を 1 枚以上選んでください");
  if (input.photos.length > MAX_REFERENCE_PHOTOS) {
    throw new SketchError(`参照にできる写真は ${MAX_REFERENCE_PHOTOS} 枚までです`);
  }

  const styleReference = await loadStyleReference(input.styleReferenceKey);

  let prompt = buildSketchPrompt(input.extraPrompt);
  const photos = [...input.photos];
  if (input.revisionOf) {
    // 直したい候補を末尾の基準スケッチの手前に置き、どれを直すのかを本文でも伝える
    photos.push(input.revisionOf);
    const note = input.revisionNote?.trim();
    prompt +=
      "\n\n作り直しの指示：\n" +
      "- 最後から2枚目の画像は、今回作った前回案のスケッチです\n" +
      "- 服装の解釈はこの前回案を引き継ぎつつ、次の指摘を直した新しい1枚を作ってください\n" +
      (note ? `- ${note}\n` : "");
  }

  const count = input.count ?? SKETCH_CANDIDATE_COUNT;
  const raw = await callOpenAIEdits(photos, styleReference, prompt, count);

  const stamp = Date.now();
  const saved: GeneratedSketch[] = [];
  for (const [i, png] of raw.entries()) {
    const padded = await padToCardAspect(png);
    const key = `meetgreet/${input.meetGreetId}/sketch/${stamp}-${i}.png`;
    await uploadToR2(key, padded, "image/png");
    saved.push({ key, url: getR2PublicUrl(key) });
  }
  return saved;
}
