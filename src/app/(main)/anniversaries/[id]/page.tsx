import { auth } from "@/lib/auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, CalendarHeart, ExternalLink, Trash2 } from "lucide-react";
import { SubmitButton } from "@/components/submit-button";
import { getAnniversaryById, listArticlesForAnniversaryPicker } from "@/lib/domain/anniversaries";
import { ASSET_KIND_LABELS, formatDate, toJstDateOnly } from "@/lib/utils";
import { AnniversaryForm } from "../anniversary-form";
import { deleteAnniversaryAction, updateAnniversaryAction } from "../actions";

export default async function AnniversaryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) notFound();

  const { id } = await params;
  const row = await getAnniversaryById(id, session.user.clearance);
  if (!row) notFound();

  const canEdit = ["admin", "member"].includes(session.user.role);
  const articles = canEdit ? await listArticlesForAnniversaryPicker() : [];
  const record = row.asset?.sourceRecords[0];
  const sourceUrl = row.sourceUrl || record?.url || null;
  const [y, m, d] = row.date.split("-").map(Number);

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <Link
          href="/anniversaries"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-3"
        >
          <ArrowLeft className="h-4 w-4" />
          記念日一覧に戻る
        </Link>
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <CalendarHeart className="h-6 w-6 text-green-600" />
          {m}/{d} {row.title}
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          {y}年{m}月{d}日{row.description && ` — ${row.description}`}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h3 className="text-xs font-medium text-slate-500 mb-2">出典</h3>
          {row.asset ? (
            <div className="text-sm">
              <Link href={`/assets/${row.asset.id}`} className="text-green-700 hover:underline">
                {row.asset.title || "(無題)"}
              </Link>
              <p className="text-xs text-slate-400 mt-0.5">
                {ASSET_KIND_LABELS[row.asset.kind] ?? row.asset.kind}
                {row.asset.canonicalDate && ` · ${formatDate(row.asset.canonicalDate)}`}
                {record?.publisher && ` · ${record.publisher.trim()}`}
              </p>
            </div>
          ) : (
            <p className="text-sm text-slate-400">アセットなし</p>
          )}
          {sourceUrl && (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 mt-2 break-all"
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              {sourceUrl}
            </a>
          )}
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h3 className="text-xs font-medium text-slate-500 mb-2">関連記事</h3>
          {row.article ? (
            <Link href={`/articles/${row.article.shortId}`} className="text-sm text-green-700 hover:underline">
              {row.article.title || row.article.path}
            </Link>
          ) : (
            <p className="text-sm text-slate-400">なし</p>
          )}
          <p className="text-xs text-slate-400 mt-2">
            クリアランス: {row.classification} · 更新: {formatDate(row.updatedAt)}
          </p>
        </div>
      </div>

      {canEdit && (
        <>
          <h2 className="text-lg font-semibold text-slate-900 mb-3">編集</h2>
          <AnniversaryForm
            action={updateAnniversaryAction.bind(null, row.id)}
            articles={articles}
            asset={
              row.asset
                ? { id: row.asset.id, title: row.asset.title, date: toJstDateOnly(row.asset.canonicalDate) }
                : null
            }
            initial={{
              date: row.date,
              title: row.title,
              description: row.description,
              sourceUrl: row.sourceUrl ?? "",
              articleId: row.article?.id ?? "",
              classification: row.classification,
            }}
            submitLabel="保存"
            pendingLabel="保存中..."
          />

          <div className="mt-6 pt-4 border-t border-slate-200">
            <form action={deleteAnniversaryAction.bind(null, row.id)}>
              <SubmitButton
                className="px-4 py-2 text-sm font-medium text-red-600 border border-red-200 hover:bg-red-50 rounded-lg"
                pendingText="削除中..."
              >
                <Trash2 className="h-4 w-4" />
                この記念日を削除
              </SubmitButton>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
