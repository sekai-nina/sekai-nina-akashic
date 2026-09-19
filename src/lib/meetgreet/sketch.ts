/**
 * 服装スケッチの生成 (#108)。
 *
 * ドシエで選んだその日の写真と、シリーズの画風をそろえるための「基準スケッチ」を
 * OpenAI の画像編集 API (gpt-image-1) に渡し、候補を 2 枚作って R2 に置く。
 * 人が 1 枚選んで確定するか、修正指示を書いて作り直す。
 *
 * **基準スケッチは回をまたいで同じ 1 枚**（既定は R2 の `STYLE_REFERENCE_KEY`）。直前の生成結果を
 * 参照し続けるとコピーのコピーで画風が少しずつずれていくため。差し替えとプロンプトの編集は
 * `SketchSetting` に置いてあり、画面から行う (#136)。
 */

import sharp from "sharp";
import { downloadFromDrive, isDriveEnabled } from "@/lib/drive";
import { getR2PublicUrl, isR2Configured, uploadToR2 } from "@/lib/r2";
import { maxReferencePhotos, SKETCH_CANDIDATE_COUNT } from "./config";
import { toPixelRect, type CropRect } from "./crop";
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

/**
 * 参照画像の長辺。原本は数 MB あるがスケッチの参照にはこれで十分で、
 * 15 枚ぶんを抱えたまま multipart で送るとメモリも転送時間も無駄になる。
 */
const REFERENCE_MAX_EDGE = 1280;

export interface SketchSourceImage {
  /** ファイル名。拡張子と Content-Type を食い違わせない */
  filename: string;
  contentType: string;
  bytes: Buffer;
}

/** 生成・保存の失敗 (上流の問題。呼び出し側は 502) */
export class SketchError extends Error {}

/** 設定漏れ (こちら側の問題。呼び出し側は 500) */
export class SketchConfigError extends Error {}

/**
 * 参照用に縮小し、gpt-image-1 が受け取れる png / jpeg / webp に揃える。
 * HEIC など API が弾く形式も、ここで jpeg に倒して救う。
 */
async function toReferenceImage(
  id: string,
  bytes: Buffer,
  crop?: CropRect
): Promise<SketchSourceImage | null> {
  try {
    const meta = await sharp(bytes).metadata();
    // **切り抜きは縮小より先。** 割合は元画像に対するものなので、縮めた後に当てるとずれる
    const source = crop ? await cropBytes(bytes, crop) : bytes;
    if (source === null) return null; // 切れなかった = 隣の人ごと送らない
    const pipeline = sharp(source).rotate().resize(REFERENCE_MAX_EDGE, REFERENCE_MAX_EDGE, {
      fit: "inside",
      withoutEnlargement: true,
    });
    if (meta.format === "png") {
      return { filename: `${id}.png`, contentType: "image/png", bytes: await pipeline.png().toBuffer() };
    }
    if (meta.format === "webp") {
      return {
        filename: `${id}.webp`,
        contentType: "image/webp",
        bytes: await pipeline.webp({ quality: 90 }).toBuffer(),
      };
    }
    return {
      filename: `${id}.jpg`,
      contentType: "image/jpeg",
      bytes: await pipeline.jpeg({ quality: 90 }).toBuffer(),
    };
  } catch {
    return null; // 壊れた画像・読めない形式は 1 枚落とすだけにする
  }
}

/**
 * 割合の枠で切り抜く。
 *
 * **枠は「正立の画像」に対する割合。** 画面は
 * `/api/meetgreets/[id]/sketch-reference/[assetId]` が返す画像 (= この関数に入るのと
 * 同じ経路で作った、Exif を当てたもの) の上で枠を引く。サムネイルを直接見せると、
 * R2 の webp (Exif を当てずに作る = 生の画素) と Drive のプロキシ (ブラウザが当てる
 * = 正立) で座標系が変わり、どちらで引いたかをサーバーが知れない。
 *
 * **切り出せなかったら null。** 枠があるということは「隣の人を送りたくない」なので、
 * 切れないまま全体を送るくらいなら、その 1 枚を落とすほうが安全。
 */
export async function cropBytes(bytes: Buffer, crop: CropRect): Promise<Buffer | null> {
  try {
    const upright = await sharp(bytes).rotate().toBuffer();
    const meta = await sharp(upright).metadata();
    const rect = toPixelRect(crop, meta.width ?? 0, meta.height ?? 0);
    if (!rect) return null;
    return await sharp(upright).extract(rect).toBuffer();
  } catch {
    return null;
  }
}

/**
 * アセットの画像バイト列を取る。Drive に原本があればそれを、無ければ R2 のサムネイルを使う
 * (サムネイルは 640px なので、素材感やアクセサリーの再現は落ちる)。
 *
 * **1 枚取れなくても全体を落とさない。** Drive の 404 / 権限切れも、相対 URL の
 * サムネイル (`/api/...`) を掴んだときも null を返して次に進む。
 */
export async function loadAssetImage(
  asset: {
    id: string;
    storageProvider: string;
    storageKey: string | null;
    thumbnailUrl: string | null;
  },
  /** 参照に使う範囲 (割合)。未指定なら画像全体 (#136) */
  crop?: CropRect
): Promise<SketchSourceImage | null> {
  if (asset.storageProvider === "gdrive" && asset.storageKey && isDriveEnabled()) {
    try {
      const bytes = await downloadFromDrive(asset.storageKey);
      if (bytes) {
        const img = await toReferenceImage(asset.id, bytes, crop);
        if (img) return img;
      }
    } catch {
      // Drive が落ちている / ファイルが消えている → サムネイルで代替する
    }
  }
  // 相対 URL (Drive 画像のプロキシ) はサーバーからは引けないので使わない
  if (asset.thumbnailUrl && /^https?:\/\//.test(asset.thumbnailUrl)) {
    try {
      const res = await fetch(asset.thumbnailUrl);
      if (res.ok) {
        return await toReferenceImage(asset.id, Buffer.from(await res.arrayBuffer()), crop);
      }
    } catch {
      // ネットワークエラーも 1 枚落とすだけ
    }
  }
  return null;
}

/** R2 の画像を 1 枚取る (基準スケッチ・作り直しの元候補) */
export async function loadR2Image(key: string, filename: string): Promise<SketchSourceImage> {
  const url = getR2PublicUrl(key);
  if (!/^https?:\/\//.test(url)) throw new SketchConfigError("R2_PUBLIC_URL が未設定です");
  const res = await fetch(url);
  if (!res.ok) throw new SketchError(`画像を読めませんでした (${res.status}): ${key}`);
  return { filename, contentType: "image/png", bytes: Buffer.from(await res.arrayBuffer()) };
}

/**
 * 基準スケッチを R2 から取る。
 *
 * **差し替えた見本が引けなければ既定に落とす。** 消された / key を打ち間違えた設定 1 つで
 * 全員の生成が 502 になるより、既定の画風で作り続けるほうがまし (`SketchSetting` の
 * 「空なら既定」と同じ考え方)。
 */
export async function loadStyleReference(
  key = STYLE_REFERENCE_KEY
): Promise<SketchSourceImage> {
  try {
    return await loadR2Image(key, "style-reference.png");
  } catch (e) {
    if (key === STYLE_REFERENCE_KEY) throw e;
    return loadR2Image(STYLE_REFERENCE_KEY, "style-reference.png");
  }
}

/**
 * 1536x1024 を左右の白埋めで 1.91:1 にする。
 * 生成物は一切切らないので、頭や補助スケッチが欠けることはない。
 */
export async function padToCardAspect(png: Buffer): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  // 寸法が読めない = 壊れている。既定値で埋めると比率が狂うので止める
  if (!meta.width || !meta.height) {
    throw new SketchError("生成された画像の寸法を読み取れませんでした");
  }
  const targetWidth = Math.round(meta.height * TARGET_ASPECT);
  if (targetWidth <= meta.width) return png; // 既に十分横長なら何もしない

  const pad = targetWidth - meta.width;
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
  /** gpt-image-1 はトークン課金なので利用量が返る (/costs への自己申告に使う) */
  usage?: { input_tokens?: number; output_tokens?: number };
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
  if (!apiKey) throw new SketchConfigError("OPENAI_API_KEY が未設定です");

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
    // Buffer をそのまま BlobPart にできないので包む。`img.bytes.buffer` ではなく
    // Buffer 自体を渡すこと (プールされた ArrayBuffer 全体を晒さないため)
    form.append(
      "image[]",
      new Blob([new Uint8Array(img.bytes)], { type: img.contentType }),
      img.filename
    );
  }

  const res = await fetch(OPENAI_EDITS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const json = (await res.json().catch(() => ({}))) as OpenAIImageResponse;
  if (!res.ok) {
    // 本文はキーの一部や組織 ID を含むことがあるので、そのまま画面に出さない
    console.error("[meetgreet/sketch] OpenAI error", res.status, json.error?.message);
    throw new SketchError(`画像生成に失敗しました (${res.status})`);
  }
  // 利用量を /costs に自己申告する。画像 API も usage/completions には出る (2026-09-19 に実測) が、
  // 向こうから分かるのは API キー単位までで、akashic のキーは他の機能と共用なので機能別には割れない。
  // 失敗しても生成は止めない
  if (json.usage) {
    try {
      // **動的 import にする。** 静的に読むと、このモジュールを import するテストが
      // @/lib/db を巻き込み、DATABASE_URL の無い CI で PrismaClient の生成に失敗する
      const { recordUsage } = await import("@/lib/costs/usage");
      await recordUsage({
        provider: "openai",
        model: OPENAI_IMAGE_MODEL,
        feature: "akashic.meetgreet_sketch",
        inputTokens: json.usage.input_tokens ?? 0,
        outputTokens: json.usage.output_tokens ?? 0,
        requests: 1,
      });
    } catch (e) {
      console.warn(`[meetgreet/sketch] 利用量の記録に失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
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
  /** 画面で編集されたプロンプト本体 (#136)。未指定なら組み込みの既定 */
  basePrompt?: string;
}

export interface GeneratedSketch {
  key: string;
  url: string;
}

/**
 * 候補を生成して R2 に置き、key を返す。DB には触らない (呼び出し側が持つ)。
 *
 * 作り直しのときは「直したい候補 + 修正指示」を足す。元の参照写真も一緒に渡すので、
 * 服装の情報が落ちない。**その 1 枚ぶん参照写真の上限が下がる**（合計 16 枚まで）。
 */
export async function generateSketches(input: GenerateSketchInput): Promise<GeneratedSketch[]> {
  if (!isR2Configured()) throw new SketchConfigError("R2 が未設定です (生成した画像を保存できません)");
  if (input.photos.length === 0) throw new SketchError("参照にする写真を 1 枚以上選んでください");
  const limit = maxReferencePhotos(!!input.revisionOf);
  if (input.photos.length > limit) {
    throw new SketchError(`参照にできる写真は ${limit} 枚までです`);
  }

  const styleReference = await loadStyleReference(input.styleReferenceKey);

  let prompt = buildSketchPrompt(input.extraPrompt, input.basePrompt);
  const photos = [...input.photos];
  if (input.revisionOf) {
    // 直したい候補を末尾の基準スケッチの手前に置き、どれを直すのかを本文でも伝える
    photos.push(input.revisionOf);
    const note = input.revisionNote?.trim();
    prompt +=
      "\n\n作り直しの指示：\n" +
      "- 最後から2枚目の画像は、今回作った前回案のスケッチです\n" +
      "- 服装の解釈はこの前回案を引き継ぎつつ、次の指摘を直したスケッチを作ってください\n" +
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
