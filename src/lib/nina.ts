/**
 * 坂井新奈まわりの定数と純粋関数。DB を import しないので、クライアント部品・テストからも使える。
 *
 * 出演の 3 状態 (#261):
 *   出ていない = Asset.ninaAbsent (本人の投稿 = author で紐づいていても、写っていなければ立てる)
 *   出ている   = 坂井新奈の AssetEntity があり、ninaAbsent が無い (roleLabel は問わない)
 *   未確認     = どちらも無い
 * author 以外の紐づきと ninaAbsent は両立させない (紐づけると ninaAbsent を外す)。
 * 付け外しは src/lib/domain/nina-appearance.ts を通す。
 */

/** 坂井新奈の entityId */
export const NINA_ENTITY_ID = "cmmtp8vrg0004mo381neyztvn";

export const NINA_APPEARANCES = ["appears", "absent", "unchecked"] as const;
export type NinaAppearance = (typeof NINA_APPEARANCES)[number];

export function isNinaAppearance(v: unknown): v is NinaAppearance {
  return typeof v === "string" && (NINA_APPEARANCES as readonly string[]).includes(v);
}

/**
 * entities は坂井新奈で絞っていなくてよい。ninaAbsent を優先する (検索の絞り込みも同じ)。
 * 本人の投稿 (author) でも写っていない画像があるため
 */
export function ninaAppearanceOf(asset: { ninaAbsent: boolean; entities: { entityId: string }[] }): NinaAppearance {
  if (asset.ninaAbsent) return "absent";
  return asset.entities.some((e) => e.entityId === NINA_ENTITY_ID) ? "appears" : "unchecked";
}
