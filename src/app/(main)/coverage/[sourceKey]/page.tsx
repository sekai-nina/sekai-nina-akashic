import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getMatrix, listItems } from "@/lib/domain/coverage";
import { ItemListClient } from "./items-client";

/**
 * アイテム一覧ページ（v2 の主戦場）。ソースの導出アイテムを観点タブで見ながら
 * チェックしていく。行を展開すると全観点のチェックボックスが並ぶ（アイテム起点ビュー）。
 * admin / member は編集可、viewer は閲覧のみ。
 */
export default async function ItemListPage({
  params,
  searchParams,
}: {
  params: Promise<{ sourceKey: string }>;
  searchParams: Promise<{ lens?: string; order?: string; page?: string }>;
}) {
  const session = await auth();
  if (!session?.user) notFound();
  const clearance = session.user.clearance;
  const canEdit = ["admin", "member"].includes(session.user.role);

  const { sourceKey } = await params;
  const sp = await searchParams;
  const order: "asc" | "desc" = sp.order === "desc" ? "desc" : "asc";
  const page = Math.max(1, Number(sp.page ?? "1") || 1);
  const pageSize = 100;

  // マトリクスから当該ソースの情報・観点別進捗を得る（済/総・continuousUntil）
  const matrix = await getMatrix(clearance);
  const source = matrix.dataSources.find((d) => d.key === sourceKey);
  if (!source) notFound();

  const lenses = matrix.lenses.filter((l) => l.active);
  const selectedLensKey =
    sp.lens && lenses.some((l) => l.key === sp.lens)
      ? sp.lens
      : (lenses[0]?.key ?? null);

  // 観点別進捗（このソースのセルから）
  const lensProgress: Record<
    string,
    { checked: number; total: number; continuousUntil: string | null }
  > = {};
  for (const cell of matrix.cells) {
    if (cell.dataSourceId !== source.id) continue;
    lensProgress[cell.lensKey] = {
      checked: cell.checkedItems,
      total: cell.totalItems,
      continuousUntil: cell.continuousUntil,
    };
  }

  // アイテム行（lens 未指定 = 全観点の checkedLensKeys 付き。行展開に必要）
  const items = await listItems(sourceKey, { order, page, pageSize }, clearance);

  return (
    <div className="max-w-full">
      <ItemListClient
        source={{
          key: source.key,
          name: source.name,
          itemRule: source.itemRule,
          totalItems: source.totalItems,
          public: source.public,
        }}
        lenses={lenses.map((l) => ({ key: l.key, name: l.name }))}
        lensProgress={lensProgress}
        selectedLensKey={selectedLensKey}
        items={items.items}
        order={order}
        page={items.page}
        pageSize={items.pageSize}
        total={items.total}
        canEdit={canEdit}
      />
    </div>
  );
}
