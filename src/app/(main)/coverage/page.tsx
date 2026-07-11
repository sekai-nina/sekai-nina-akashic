import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getMatrix } from "@/lib/domain/coverage";
import { CoverageClient } from "./coverage-client";

/**
 * 収集カバレッジ管理 — 観点(Lens) × データソース(DataSource) のマトリクスで
 * 「何日の分まで反映したか」を記録する。実運用の主動線は「今日まで反映」ボタン。
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
          観点 × データソースごとに「何日の分まで反映したか」を記録します。空セルは未着手（クリックで作成）。
          {!canEdit && "（閲覧のみ）"}
        </p>
      </div>

      <CoverageClient matrix={matrix} canEdit={canEdit} />
    </div>
  );
}
