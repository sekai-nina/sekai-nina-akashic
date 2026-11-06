/** 同じ `clipGroupId` の行を 1 つのクリップにする (一覧の順は先頭の行の位置)。 */
export interface GroupableClip {
  id: string;
  note: string;
  clipGroupId: string | null;
  sortOrder: number;
}

export interface ClipGroup<T> {
  /** カードの代表。メモを持つ行を優先するので、メモの編集はこの行に効く */
  head: T;
  /** sortOrder 順の全行 */
  members: T[];
}

export function groupClipRows<T extends GroupableClip>(rows: T[]): ClipGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const key = row.clipGroupId ?? row.id;
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  return [...buckets.values()].map((bucket) => {
    const members = [...bucket].sort((a, b) => a.sortOrder - b.sortOrder);
    return { head: members.find((m) => m.note.trim() !== "") ?? members[0], members };
  });
}
