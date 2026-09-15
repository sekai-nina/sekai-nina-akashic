/**
 * 「未 push」バッジ。`editedAt` があれば akashic 側の編集 (取り込み直後の正規化差分と区別する)。
 * 詳細と編集ページの見出しで同じものを出す。
 */
export function UnpushedBadge({ editedAt }: { editedAt: Date | null }) {
  return (
    <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
      {editedAt ? "akashic で編集（未 push）" : "未 push"}
    </span>
  );
}
