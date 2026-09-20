import { auth } from "@/lib/auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Megaphone, Trash2 } from "lucide-react";
import { SubmitButton } from "@/components/submit-button";
import { getAnnouncementById, renderAnnouncementBodies } from "@/lib/domain/announcements";
import { ANNOUNCEMENT_KIND_LABELS, formatDate, toJstDateTimeLocal } from "@/lib/utils";
import { AnnouncementForm } from "../announcement-form";
import { deleteAnnouncementAction, updateAnnouncementAction } from "../actions";
import "../../articles/article-content.css";

const SITE = "https://sekai-nina.com";

/** 詳細 = 公開サイトに出る形のプレビュー + 編集フォーム */
export default async function AnnouncementDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) notFound();

  const { id } = await params;
  const row = await getAnnouncementById(id);
  if (!row) notFound();

  const canEdit = ["admin", "member"].includes(session.user.role);
  const bodyHtml = (await renderAnnouncementBodies([row])).get(row.id) ?? "";
  const linkHref = row.url ? (row.url.startsWith("/") ? `${SITE}${row.url}` : row.url) : null;

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <Link
          href="/announcements"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-3"
        >
          <ArrowLeft className="h-4 w-4" />
          お知らせ一覧に戻る
        </Link>
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <Megaphone className="h-6 w-6 text-green-600" />
          {row.title}
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          {row.publishedAt ? `${formatDate(row.publishedAt, true)} 公開` : "下書き (サイトには出ない)"}
          {" · "}
          {ANNOUNCEMENT_KIND_LABELS[row.kind]}
          {" · 更新: "}
          {formatDate(row.updatedAt, true)}
        </p>
      </div>

      {/* 公開サイトの /news に出る形。本文の描画は記事と同じなので、崩れはここで気づける */}
      <section className="bg-white border border-slate-200 rounded-lg p-4 mb-8">
        <h3 className="text-xs font-medium text-slate-500 mb-3">サイトでの見え方</h3>
        <p className="text-xs text-slate-400 mb-1">
          {row.publishedAt ? formatDate(row.publishedAt) : "（公開日）"} · {ANNOUNCEMENT_KIND_LABELS[row.kind]}
        </p>
        <p className="text-base font-bold text-slate-900">{row.title}</p>
        {bodyHtml ? (
          <div className="article-content mt-2 text-sm" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
        ) : (
          <p className="text-xs text-slate-400 mt-2">本文なし</p>
        )}
        {linkHref && (
          <a
            href={linkHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-green-700 hover:underline mt-3"
          >
            詳しく →
            <ExternalLink className="h-3 w-3" />
            <span className="text-xs text-slate-400">{row.url}</span>
          </a>
        )}
        <p className="text-xs text-slate-400 mt-4 border-t border-slate-100 pt-3">
          公開済みなら数分で{" "}
          <a href={`${SITE}/news`} target="_blank" rel="noopener noreferrer" className="underline">
            {SITE}/news
          </a>{" "}
          に出る (stats Worker のキャッシュが 5 分)
        </p>
      </section>

      {canEdit && (
        <>
          <h2 className="text-lg font-semibold text-slate-900 mb-3">編集</h2>
          <AnnouncementForm
            action={updateAnnouncementAction.bind(null, row.id)}
            initial={{
              title: row.title,
              body: row.body,
              kind: row.kind,
              url: row.url ?? "",
              published: !!row.publishedAt,
              publishedAt: toJstDateTimeLocal(row.publishedAt ?? new Date()),
            }}
            submitLabel="保存"
            pendingLabel="保存中..."
          />

          <div className="mt-6 pt-4 border-t border-slate-200">
            <form action={deleteAnnouncementAction.bind(null, row.id)}>
              <SubmitButton
                className="px-4 py-2 text-sm font-medium text-red-600 border border-red-200 hover:bg-red-50 rounded-lg"
                pendingText="削除中..."
              >
                <Trash2 className="h-4 w-4" />
                このお知らせを削除
              </SubmitButton>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
