import { auth } from "@/lib/auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Megaphone, Plus } from "lucide-react";
import { listAnnouncements } from "@/lib/domain/announcements";
import { ANNOUNCEMENT_KIND_LABELS, formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * お知らせ一覧。新しい順で、下書きは上にまとめて出す (= 書きかけを忘れない)。
 * 公開サイトはこの公開済みぶんをトップと /news に出す
 */
export default async function AnnouncementsPage() {
  const session = await auth();
  if (!session?.user) notFound();

  const rows = await listAnnouncements("all", 200);
  const drafts = rows.filter((r) => !r.publishedAt);
  const published = rows.filter((r) => !!r.publishedAt);
  const canEdit = ["admin", "member"].includes(session.user.role);

  const Row = ({ a }: { a: (typeof rows)[number] }) => (
    <Link
      href={`/announcements/${a.id}`}
      className="flex items-center gap-4 px-4 py-3 hover:bg-slate-50 transition-colors"
    >
      <span className="shrink-0 w-24 font-mono text-xs text-slate-500">
        {a.publishedAt ? formatDate(a.publishedAt) : "下書き"}
      </span>
      <span className="shrink-0 w-10 text-xs text-slate-500">{ANNOUNCEMENT_KIND_LABELS[a.kind]}</span>
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium text-slate-900">{a.title}</span>
        {a.body && <p className="text-xs text-slate-500 mt-0.5 truncate">{a.body.split("\n")[0]}</p>}
      </div>
      {a.url && <span className="shrink-0 text-xs text-slate-400 truncate max-w-48">{a.url}</span>}
    </Link>
  );

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Megaphone className="h-6 w-6 text-green-600" />
            お知らせ
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            公開サイトのトップと /news に出す運営からの知らせ。保存すれば数分でサイトに出る (再ビルド不要)
          </p>
        </div>
        {canEdit && (
          <Link
            href="/announcements/new"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors"
          >
            <Plus className="h-4 w-4" />
            新規作成
          </Link>
        )}
      </div>

      {rows.length === 0 && (
        <div className="bg-white border border-slate-200 rounded-lg px-4 py-8 text-center text-slate-400 text-sm">
          お知らせがまだありません。機能を足したとき・記事をまとめて更新したときに「新規作成」から
        </div>
      )}

      {drafts.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-slate-500 mb-2">下書き ({drafts.length})</h2>
          <div className="bg-white border border-dashed border-slate-300 rounded-lg divide-y divide-slate-100">
            {drafts.map((a) => (
              <Row key={a.id} a={a} />
            ))}
          </div>
        </section>
      )}

      {published.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-slate-500 mb-2">公開済み ({published.length})</h2>
          <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
            {published.map((a) => (
              <Row key={a.id} a={a} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
