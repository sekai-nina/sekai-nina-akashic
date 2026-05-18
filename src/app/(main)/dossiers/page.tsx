import Link from "next/link";
import { FolderSearch, Plus, Lock, Eye, Pencil } from "lucide-react";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { listDossiers } from "@/lib/domain/dossiers";
import { formatDate } from "@/lib/utils";

const CLASSIFICATION_LABEL: Record<string, string> = {
  internal: "一般",
  confidential: "限定",
  restricted: "極秘",
};

const CLASSIFICATION_BADGE: Record<string, string> = {
  internal: "bg-blue-100 text-blue-700",
  confidential: "bg-orange-100 text-orange-700",
  restricted: "bg-red-100 text-red-700",
};

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

      {dossiers.length === 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-8 text-center">
          <FolderSearch className="h-10 w-10 mx-auto text-slate-300 mb-2" />
          <p className="text-sm text-slate-500">まだドシエがありません。</p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {dossiers.map((d) => {
          const isOwner = d.ownerId === session.user.id;
          return (
            <Link
              key={d.id}
              href={`/dossiers/${d.id}`}
              prefetch
              className="block bg-white border border-slate-200 hover:border-indigo-300 rounded-lg p-4 transition-colors"
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <h2 className="text-sm font-semibold text-slate-900 line-clamp-2 flex-1">
                  {d.title || "(無題)"}
                </h2>
                <span
                  className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${CLASSIFICATION_BADGE[d.classification] ?? "bg-slate-100 text-slate-600"}`}
                >
                  {CLASSIFICATION_LABEL[d.classification] ?? d.classification}
                </span>
              </div>
              {d.summary && (
                <p className="text-xs text-slate-500 line-clamp-2 mb-3">{d.summary}</p>
              )}
              <div className="flex items-center justify-between text-[11px] text-slate-500">
                <div className="flex items-center gap-2">
                  <span>{d._count.items} 件</span>
                  {d._count.placeCandidates > 0 && (
                    <span>· 場所 {d._count.placeCandidates}</span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {d.viewMode === "private" ? (
                    <Lock className="h-3 w-3" />
                  ) : (
                    <Eye className="h-3 w-3" />
                  )}
                  {d.editMode === "clearance" && <Pencil className="h-3 w-3" />}
                  {!isOwner && d.owner.name && (
                    <span className="ml-1 truncate max-w-[80px]">{d.owner.name}</span>
                  )}
                </div>
              </div>
              <p className="mt-2 text-[10px] text-slate-400">
                更新 {formatDate(d.updatedAt)}
              </p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
