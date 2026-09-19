/**
 * その回だけの参考画像 (#159)。
 *
 * スケッチの参照に使えるのは**ドシエにある画像だけ**という制限があり
 * (任意のアセットを外部 AI に送らせないため)、そこは変えていない。
 * 「アーカイブに残す価値は無いが、スケッチの参照には使いたい 1 枚」を、
 * アセットにもドシエにも入れずに R2 へ置いて使えるようにするための入れ物。
 *
 * DB を触らない純粋関数。
 */

/** R2 に置いた参考画像 1 枚 */
export interface SketchRef {
  /** R2 key */
  key: string;
  /** 画面に出す名前 (アップロード時のファイル名) */
  name: string;
}

/** 1 回あたりに持てる参考画像の数 (参照の上限そのものは maxReferencePhotos) */
export const MAX_SKETCH_REFS = 20;

/** この回の参考画像が置かれる場所か (他の回や無関係な R2 オブジェクトを弾く) */
export function isRefKeyOf(meetGreetId: string, key: string): boolean {
  return key.startsWith(`${refPrefix(meetGreetId)}/`);
}

/** 参考画像の置き場 */
export function refPrefix(meetGreetId: string): string {
  return `meetgreet/${meetGreetId}/refs`;
}

/**
 * Json 列から参考画像の一覧を取り出す (中身を信用しない)。
 * 壊れているものは落とす (生成を止めない)。
 */
export function refsFromJson(value: unknown): SketchRef[] {
  if (!Array.isArray(value)) return [];
  const out: SketchRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.key !== "string" || r.key.length === 0) continue;
    out.push({ key: r.key, name: typeof r.name === "string" ? r.name : r.key });
  }
  return out;
}
