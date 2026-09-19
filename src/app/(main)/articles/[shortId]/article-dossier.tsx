"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FolderPlus, FolderSearch, Loader2 } from "lucide-react";
import { ensureArticleDossierAction } from "../actions";

/**
 * 記事詳細の「素材ドシエ」(#41)。
 *
 * あればリンク、無ければ作るボタン。クリップを「この記事に足す」= その記事のドシエへ移す、
 * なので、記事にクリップを足したくなったらここで先にドシエを作る。
 */
export function ArticleDossier({
  articleId,
  shortId,
  dossier,
  canEdit,
}: {
  articleId: string;
  shortId: string;
  dossier: { id: string; title: string; itemCount: number } | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (dossier) {
    return (
      <p className="text-sm text-slate-600 flex items-center gap-1.5 flex-wrap">
        <FolderSearch className="h-4 w-4 text-indigo-600" />
        素材ドシエ:
        <Link href={`/dossiers/${dossier.id}`} className="text-indigo-700 hover:underline">
          {dossier.title || "(無題)"}
        </Link>
        <span className="text-xs text-slate-400">({dossier.itemCount} 件)</span>
        <Link href="/clips" className="text-xs text-slate-500 hover:underline ml-1">
          クリップ一覧へ →
        </Link>
      </p>
    );
  }

  if (!canEdit) return null;

  const create = () => {
    setError(null);
    startTransition(async () => {
      const result = await ensureArticleDossierAction(articleId, shortId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="text-sm text-slate-600 flex items-center gap-2 flex-wrap">
      <FolderSearch className="h-4 w-4 text-slate-400" />
      <span className="text-slate-500">素材ドシエはまだありません</span>
      <button
        type="button"
        onClick={create}
        disabled={isPending}
        className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-slate-300 hover:bg-slate-50 disabled:opacity-50"
        title="クリップをこの記事に足せるようにする"
      >
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderPlus className="h-3.5 w-3.5" />}
        素材ドシエを作る
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
