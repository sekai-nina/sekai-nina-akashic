import { PlaceKind } from "@prisma/client";

const KINDS = new Set<string>(Object.values(PlaceKind));

/**
 * API / フォームから来た kind を正規化する。
 * - undefined … 指定なし (更新なら「変更しない」)
 * - null / "" … 未設定に戻す
 * - enum の値 … そのまま
 * - それ以外 … false (400 にする)
 */
export function parsePlaceKind(value: unknown): PlaceKind | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value === "string" && KINDS.has(value)) return value as PlaceKind;
  return false;
}
