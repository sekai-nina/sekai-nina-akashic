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

/**
 * 既存の紐づきのうち roleLabel を書き換えるものを、値ごとに entityId をまとめて返す (updateMany 用)。
 * 新規 (existingIds に無い) と、値を渡されなかったものは含めない
 */
export function groupRoleLabelUpdates(
  entities: { entityId: string; roleLabel?: string | null }[],
  existingIds: ReadonlySet<string>
): Map<string, string[]> {
  const byRole = new Map<string, string[]>();
  for (const e of entities) {
    if (!existingIds.has(e.entityId)) continue;
    const key = providedRoleLabel(e.roleLabel);
    if (key === undefined) continue;
    byRole.set(key, [...(byRole.get(key) ?? []), e.entityId]);
  }
  return byRole;
}

/** upsert の `update` に渡すもの。値が無ければ空 (= roleLabel に触らない) */
export function roleLabelUpdate(roleLabel: string | null | undefined): { roleLabel?: string } {
  const v = providedRoleLabel(roleLabel);
  return v === undefined ? {} : { roleLabel: v };
}
