/**
 * 参照写真の切り抜き枠 (#136)。
 *
 * ミーグリの写真はツーショットが多く、そのまま参照に渡すと隣の人の服を拾う。
 * 本人だけを送れるよう、回ごとに「この画像をこの範囲で使う」を覚える。
 *
 * **画素ではなく割合 (0〜1) で持つ。** 枠を引くのはサムネイル (640px) の上だが、
 * 生成に使うのは Drive の原本を 1280px に縮めたもので、解像度が違う。
 * 割合なら元の大きさに関係なく同じところを指せる。
 */

/** 画像に対する割合の矩形。x/y は左上 */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** assetId → 切り抜き枠 */
export type CropMap = Record<string, CropRect>;

/** sharp の extract に渡せる最小の辺 (これ未満は潰れて参照にならない) */
export const MIN_CROP_PIXELS = 16;

/** 枠が小さすぎないか (割合ベースの最低限。画素の下限は切り出し側で見る) */
const MIN_FRACTION = 0.02;

function isFraction(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** 1 件ぶんの枠として妥当か。画像の外にはみ出すもの・潰れているものは弾く */
export function isValidCrop(value: unknown): value is CropRect {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  if (!isFraction(c.x) || !isFraction(c.y) || !isFraction(c.w) || !isFraction(c.h)) return false;
  if (c.w < MIN_FRACTION || c.h < MIN_FRACTION) return false;
  // 端数の丸めで 1 をわずかに超えることがあるので、少しだけ許容する
  return c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001;
}

/**
 * Json 列から切り抜き枠を取り出す (中身を信用しない)。
 * 壊れている / 範囲外のものは「枠なし」として落とす (生成を止めない)
 */
export function cropsFromJson(value: unknown): CropMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: CropMap = {};
  for (const [assetId, rect] of Object.entries(value as Record<string, unknown>)) {
    if (isValidCrop(rect)) out[assetId] = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  }
  return out;
}

/**
 * 枠を差し替えた結果を返す (元は変えない)。
 * `null` を渡した assetId は枠を外す = 画像全体を使う
 */
export function withCrops(current: CropMap, changes: Record<string, CropRect | null>): CropMap {
  const next: CropMap = { ...current };
  for (const [assetId, rect] of Object.entries(changes)) {
    if (rect === null) delete next[assetId];
    else if (isValidCrop(rect)) next[assetId] = rect;
  }
  return next;
}

/**
 * 割合の枠を、その画像の画素に直す。
 *
 * **切り出せないときは null を返して枠を無視させる。** 枠のせいで参照が 1 枚減るより、
 * 切らずに送るほうがまし (隣の人が写るが、生成自体は続く)。
 */
export function toPixelRect(
  crop: CropRect,
  width: number,
  height: number
): { left: number; top: number; width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const left = Math.max(0, Math.min(width - 1, Math.round(crop.x * width)));
  const top = Math.max(0, Math.min(height - 1, Math.round(crop.y * height)));
  const w = Math.min(width - left, Math.round(crop.w * width));
  const h = Math.min(height - top, Math.round(crop.h * height));
  if (w < MIN_CROP_PIXELS || h < MIN_CROP_PIXELS) return null;
  return { left, top, width: w, height: h };
}
