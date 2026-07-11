import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getMatrix } from "@/lib/domain/coverage";
import { CoverageClient } from "./coverage-client";

/**
 * 収集カバレッジ管理 — 観点(Lens) × データソース(DataSource) のマトリクス。
 * v2 ではチェックの単位を「アイテム（ブログ記事1本・トーク1日分）」にし、
 * セルの済/総・「〜◯日まで反映済み」はアイテムチェックからの導出値。
 * セルをクリックするとアイテム一覧ページへ遷移する。
 * admin / member は編集可、viewer は閲覧のみ。
 */
export default async function CoveragePage() {
  const session = await auth();
  if (!session?.user) notFound();

  const matrix = await getMatrix(session.user.clearance);
  const canEdit = ["admin", "member"].includes(session.user.role);

  return (
    <div className="max-w-full">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">収集カバレッジ</h1>
        <p className="text-slate-500 text-sm mt-1">
          観点 × データソースごとに、収集済みアイテムの割合と「〜◯日まで反映済み」を表示します。
          セルをクリックするとアイテム一覧が開きます。
          {!canEdit && "（閲覧のみ）"}
        </p>
      </div>

      <CoverageClient matrix={matrix} canEdit={canEdit} />
    </div>
  );
}
