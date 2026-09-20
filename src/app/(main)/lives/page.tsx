import Link from "next/link";
import { notFound } from "next/navigation";
import { Plus } from "lucide-react";
import { auth } from "@/lib/auth";
import { listLives, livePeriodLabel } from "@/lib/domain/lives";
import { formatDate } from "@/lib/utils";

/**
 * ライブ記事の作成ワークフロー (#148)。
 * 1 つのライブ (ツアー) = 1 行で、公演 → 素材 (ドシエ) → レポ (X) → スケッチ → 記事 の進み具合を一覧する。
 */
export default async function LivesPage() {
  const session = await auth();
  if (!session?.user) notFound();

  const rows = await listLives(session.user);

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">ライブ</h1>
          <p className="text-slate-500 text-sm mt-1">
            ライブ名と公演から素材のドシエと X レポ収集を自動で作り、衣装・披露曲・本人の感想をまとめた記事まで持っていく
          </p>
        </div>
        <Link
          href="/lives/new"
          className="inline-flex items-center gap-1 h-9 px-3 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800 shrink-0"
        >
          <Plus size={14} /> 新規作成
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-lg p-10 text-center text-sm text-slate-500">
          まだありません。「新規作成」からライブ名と公演を入れるとドシエと X レポ収集が用意されます。
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
          {rows.map((r) => {
            const items = r.dossier?.itemCount ?? 0;
            const keep = r.reports?.keep ?? 0;
            const total = r.reports?.total ?? 0;
            return (
              <Link
                key={r.id}
                href={`/lives/${r.id}`}
                className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-4 px-4 py-3 hover:bg-slate-50"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-slate-900 truncate">{r.name}</div>
                  <div className="text-xs text-slate-500 truncate mt-0.5">
                    {livePeriodLabel(r)} · {r.performances.length} 公演 · 作成{" "}
                    {formatDate(r.createdAt)}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0">
                  <Step label="素材" done={items > 0} detail={`${items}`} />
                  <Step label="レポ" done={keep > 0} detail={`${keep}/${total}`} />
                  <Step label="スケッチ" done={!!r.sketchKey} />
                  <Step
                    label="記事"
                    done={!!r.article && !r.needsSync}
                    detail={
                      r.article
                        ? r.needsSync
                          ? "要反映"
                          : r.article.dirty
                            ? "未 push"
                            : "push 済み"
                        : undefined
                    }
                  />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Step({ label, done, detail }: { label: string; done: boolean; detail?: string }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] " +
        (done
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-slate-200 bg-slate-50 text-slate-400")
      }
    >
      {label}
      {detail !== undefined && <span className="tabular-nums">{detail}</span>}
    </span>
  );
}
