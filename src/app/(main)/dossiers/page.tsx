import Link from "next/link";
import { FolderSearch, Plus } from "lucide-react";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { listDossiers } from "@/lib/domain/dossiers";
import { DossierGrid } from "./dossier-grid";

export default async function DossiersPage() {
  const session = await auth();
  if (!session?.user) notFound();

  const dossiers = await listDossiers(session.user);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <FolderSearch className="h-6 w-6 text-indigo-600" />
            特定支援
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            ある事柄に関わるソース・場所候補を1箇所に集めて俯瞰する
          </p>
        </div>
        <Link
          href="/dossiers/new"
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
        >
          <Plus className="h-4 w-4" />
          新規ドシエ
        </Link>
      </div>

      <DossierGrid
        currentUserId={session.user.id}
        dossiers={dossiers.map((d) => ({
          id: d.id,
          title: d.title,
          summary: d.summary,
          classification: d.classification,
          viewMode: d.viewMode,
          editMode: d.editMode,
          ownerId: d.ownerId,
          ownerName: d.owner.name,
          itemCount: d._count.items,
          placeCount: d._count.placeCandidates,
          updatedAt: d.updatedAt.toISOString(),
          articleCount: d._count.articles,
          articles: d.articles,
        }))}
      />
    </div>
  );
}
