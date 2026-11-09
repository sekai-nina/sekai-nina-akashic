/**
 * 既存の AssetEntity に対する roleLabel の書き込み方 (#392)。
 *
 * 紐づきは `@@unique([assetId, entityId])` で 1 行しかないので、「付け直し」で roleLabel を
 * null に上書きすると元の値 (`author` 等) は残らない。`author` が消えると統計のブログ数・
 * ワードクラウド・検索の作者絞り込みから無言で落ちる。
 * そのため、値が渡されなかった (undefined / 空文字 / 空白だけ / null) ときは既存の値を残し、
 * 中身のある値を渡したときだけ書き換える。新規に作るときは今までどおり無ければ null。
 */

/** 中身のある roleLabel だけを返す。無ければ undefined */
export function providedRoleLabel(roleLabel: string | null | undefined): string | undefined {
  const v = roleLabel?.trim();
  return v ? v : undefined;
}

/** upsert の `update` に渡すもの。値が無ければ空 (= roleLabel に触らない) */
export function roleLabelUpdate(roleLabel: string | null | undefined): { roleLabel?: string } {
  const v = providedRoleLabel(roleLabel);
  return v === undefined ? {} : { roleLabel: v };
}
