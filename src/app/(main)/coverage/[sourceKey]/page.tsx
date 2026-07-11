import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getMatrix, listItems } from "@/lib/domain/coverage";
import { ItemListClient } from "./items-client";

/**
 * アイテム一覧ページ（v2.3 = アイテム主導の消化フロー）。2モード制:
 * - 消化モード（既定・Todo型）: 全観点チップ常時表示。全観点✓で行が消える
 * - 観点モード: 選択観点のみ。✓した行が消える（単観点スイープ）
 * admin / member は編集可、viewer は閲覧のみ。
 */
export default async function ItemListPage({
  params,
  searchParams,
}: {
  params: Promise<{ sourceKey: string }>;
  searchParams: Promise<{
    lens?: string;
    order?: string;
    page?: string;
    mentions?: string;
    mode?: string;
  }>;
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
  const mode: "digest" | "lens" = sp.mode === "lens" ? "lens" : "digest"; // 消化モードが既定

  // マトリクスから当該ソースの情報・観点別進捗を得る（済/総・continuousUntil）
  const matrix = await getMatrix(clearance);
  const source = matrix.dataSources.find((d) => d.key === sourceKey);
  if (!source) notFound();

  const lenses = matrix.lenses.filter((l) => l.active);
  const selectedLensKey =
    sp.lens && lenses.some((l) => l.key === sp.lens)
      ? sp.lens
      : (lenses[0]?.key ?? null);

  // 言及フィルタ: url 系のみ有効。ブログは既定 ON（母集団の大半が無関係なため）。
  // ページ URL では mentions=1（言及ありのみ）/ mentions=0（全件表示）の2状態のみ使う。
  const mentionApplicable =
    source.itemRule === "blog_url" || source.itemRule === "source_url";
  let mentions: boolean | undefined;
  if (mentionApplicable) {
    if (sp.mentions === "1") mentions = true;
    else if (sp.mentions === "0") mentions = undefined;
    else mentions = source.key === "blog" ? true : undefined; // 既定
  }

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
  // 言及フィルタは母集団を絞るためサーバー側で適用（total/ページングに反映）。
  const items = await listItems(
    sourceKey,
    { order, page, pageSize, mentions },
    { id: session.user.id, clearance }
  );

  return (
    <div className="max-w-full">
      <ItemListClient
        source={{
          key: source.key,
          name: source.name,
          itemRule: source.itemRule,
          totalItems: source.totalItems,
          public: source.public,
          mentionApplicable,
        }}
        lenses={lenses.map((l) => ({ key: l.key, name: l.name }))}
        lensProgress={lensProgress}
        selectedLensKey={selectedLensKey}
        items={items.items}
        mode={mode}
        order={order}
        page={items.page}
        pageSize={items.pageSize}
        total={items.total}
        mentionOn={mentions === true}
        canEdit={canEdit}
      />
    </div>
  );
}
