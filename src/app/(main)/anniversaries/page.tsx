import { auth } from "@/lib/auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import { CalendarHeart, Plus } from "lucide-react";
import {
  ANNIVERSARY_TOTAL_DAYS,
  countFilledDays,
  groupByMonth,
  listAnniversaries,
  monthDayOf,
} from "@/lib/domain/anniversaries";
import { ASSET_KIND_LABELS, todayJst } from "@/lib/utils";
import { DayGrid } from "./day-grid";

export const dynamic = "force-dynamic";

export default async function AnniversariesPage() {
  const session = await auth();
  if (!session?.user) notFound();

  const rows = await listAnniversaries(session.user.clearance);
  const filled = countFilledDays(rows);
  const months = groupByMonth(rows);
  const today = monthDayOf(todayJst());
  const canEdit = ["admin", "member"].includes(session.user.role);

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <CalendarHeart className="h-6 w-6 text-green-600" />
            記念日
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            初めて〇〇した日。{ANNIVERSARY_TOTAL_DAYS} 日のうち <strong className="text-slate-900">{filled}</strong> 日が埋まっている
            {rows.length !== filled && `（${rows.length} 件）`}
          </p>
        </div>
        {canEdit && (
          <Link
            href="/anniversaries/new"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors"
          >
            <Plus className="h-4 w-4" />
            新規登録
          </Link>
        )}
      </div>

      <div className="mb-8">
        <DayGrid filled={rows.map((r) => monthDayOf(r.date))} today={today} />
      </div>

      {rows.length === 0 && (
        <div className="bg-white border border-slate-200 rounded-lg px-4 py-8 text-center text-slate-400 text-sm">
          記念日がまだありません。アセットページの「記念日に登録」か、上の「新規登録」から
        </div>
      )}

      {months
        .filter((m) => m.items.length > 0)
        .map((m) => (
          <section key={m.month} className="mb-6" id={`m${m.month}`}>
            <h2 className="text-sm font-semibold text-slate-500 mb-2">{m.month}月</h2>
            <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
              {m.items.map((a) => {
                const md = monthDayOf(a.date);
                const isToday = md === today;
                return (
                  <Link
                    key={a.id}
                    href={`/anniversaries/${a.id}`}
                    className={`flex items-center gap-4 px-4 py-3 hover:bg-slate-50 transition-colors ${isToday ? "bg-green-50/60" : ""}`}
                  >
                    <span className="shrink-0 w-14 font-mono text-sm text-slate-700">
                      {Number(md.slice(0, 2))}/{Number(md.slice(3, 5))}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="text-sm font-medium text-slate-900">{a.title}</span>
                      {isToday && (
                        <span className="ml-2 text-xs text-green-700 border border-green-200 rounded-full px-2 py-0.5">今日</span>
                      )}
                      {a.description && (
                        <p className="text-xs text-slate-500 mt-0.5 truncate">{a.description}</p>
                      )}
                    </div>
                    <div className="shrink-0 flex items-center gap-3 text-xs text-slate-400">
                      <span>{a.date.slice(0, 4)}年</span>
                      {a.asset && (
                        <span className="border border-slate-200 rounded-full px-2 py-0.5">
                          {ASSET_KIND_LABELS[a.asset.kind] ?? a.asset.kind}
                        </span>
                      )}
                      {a.article && <span className="border border-slate-200 rounded-full px-2 py-0.5">記事</span>}
                      {a.classification !== "internal" && (
                        <span className="text-amber-600">{a.classification}</span>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
    </div>
  );
}
