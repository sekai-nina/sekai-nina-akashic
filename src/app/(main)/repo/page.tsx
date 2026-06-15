import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { listCollections } from "@/lib/domain/repo";
import { NewCollectionForm } from "./new-collection-form";
import { CollectionList } from "./collection-list";

/**
 * レポ収集 — Twitter からミーグリレポを収集 → 選別 → リンクセットを書き出し。
 * 公式 X API v2 recent search（直近7日）を使用（curepo 由来）。
 */
export default async function RepoPage() {
  const session = await auth();
  if (!session?.user) notFound();

  const collections = await listCollections(session.user.clearance);
  const serialized = collections.map((c) => ({
    id: c.id,
    name: c.name,
    query: c.query,
    startDate: c.startDate,
    endDate: c.endDate,
    total: c.total,
    keep: c.keep,
    reject: c.reject,
    undecided: c.undecided,
    lastFetchedAt: c.lastFetchedAt?.toISOString() ?? null,
  }));

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">レポ収集</h1>
        <p className="text-slate-500 text-sm mt-1">
          Twitter からミーグリレポを収集 → 選別 → 書き出し（X API v2 recent search / 直近7日）
        </p>
      </div>

      <NewCollectionForm />

      <h2 className="text-sm font-medium text-slate-500 mt-8 mb-3">収集一覧</h2>
      <CollectionList items={serialized} />
    </div>
  );
}
