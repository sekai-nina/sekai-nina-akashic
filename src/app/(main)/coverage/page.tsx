import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getCollectionStatus, getSourceItemStats } from "@/lib/domain/coverage";
import Link from "next/link";
import { COVERAGE_LABELS as L } from "@/lib/utils";
import { CoverageClient } from "./coverage-client";

/** ソースごとの収集済みの日付 (#253)。admin / member は手入力・ソース管理ができ、viewer は閲覧のみ。 */
export default async function CoveragePage() {
  const session = await auth();
  if (!session?.user) notFound();

  const sources = await getCollectionStatus(session.user.clearance);
  const stats = await getSourceItemStats(sources, session.user.clearance);
  const canEdit = ["admin", "member"].includes(session.user.role);

  return (
    <div className="max-w-full">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">{L.title}</h1>
        <p className="text-slate-500 text-sm mt-1">{L.description}{!canEdit && L.readOnly}</p>
        <Link href="/progress" className="text-sm text-sky-700 hover:underline">{L.progressLink}</Link>
      </div>

      <CoverageClient sources={sources} stats={Object.fromEntries(stats)} canEdit={canEdit} />
    </div>
  );
}
