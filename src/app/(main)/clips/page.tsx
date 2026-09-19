import { Scissors } from "lucide-react";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { listClips, MAX_CLIPS_LISTED } from "@/lib/domain/clips";
import { listEditableDossiers } from "@/lib/domain/dossiers";
import { ClipsBoard, type ClipCard } from "./clips-board";

/**
 * クリップのプール (#41)。
 *
 * 記事未定の抜粋を眺めて共通点を見つけ、選んで新規 / 既存のドシエへ移す。
 * 絞り込み・並び替えは件数が小さいので画面側 (ClipsBoard) で行う。
 */
export default async function ClipsPage() {
  const session = await auth();
  if (!session?.user) notFound();
  const canEdit = ["admin", "member"].includes(session.user.role);

  const [{ clips, hasMore }, dossiers] = await Promise.all([
    listClips(session.user),
    canEdit ? listEditableDossiers(session.user, { withArticles: true }) : Promise.resolve([]),
  ]);

  const cards: ClipCard[] = clips.map((c) => ({
    id: c.id,
    excerpt: c.excerpt,
    note: c.note,
    located: c.excerptStart != null,
    createdAt: c.createdAt.toISOString(),
    createdById: c.createdById,
    createdBy: c.createdBy?.name ?? null,
    asset: c.asset
      ? {
          id: c.asset.id,
          kind: c.asset.kind,
          title: c.asset.title || c.caption || "(無題)",
          date: c.asset.canonicalDate?.toISOString() ?? null,
          thumbnailUrl: c.asset.thumbnailUrl,
          entities: c.asset.entities.map((ae) => ({
            id: ae.entity.id,
            type: ae.entity.type,
            name: ae.entity.canonicalName,
          })),
        }
      : // アセットが消された (Cascade で行ごと消えるので通常は来ない) か、RLS で見えない
        null,
  }));

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <Scissors className="h-6 w-6 text-sky-600" />
          クリップ
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          記事未定のまま取っておいた抜粋。共通点のあるものを選んで、ドシエにまとめる
        </p>
      </div>

      {hasMore && (
        <p className="mb-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          クリップが {MAX_CLIPS_LISTED} 件を超えています。古いものは表示していません。ドシエに振り分けるか削除してください
        </p>
      )}

      <ClipsBoard
        clips={cards}
        dossiers={dossiers.map((d) => ({
          id: d.id,
          title: d.title,
          articleTitles: (d.articles ?? []).map((a) => a.title),
        }))}
        currentUserId={session.user.id}
        canEdit={canEdit}
      />
    </div>
  );
}
