import Link from "next/link";
import { ExternalLink, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SiteReport } from "@/lib/domain/meetgreet-featured";
import { SITE_FEATURED_REPORTS_LIMIT } from "@/lib/meetgreet/featured-reports";

/**
 * 世界新奈の /meetgreet に出ているファンレポ (#210)。サイトと同じ拾い方 (新しい回の記事から
 * `![rep]` を順に 9 件) を DB の本文で再現する。push 待ちの記事は「push 後に出るもの」として並ぶ。
 * 9 件目より後ろは、次に新しい回で ★ を付けると押し出されて消えるもの (薄く出す)
 */
export function SiteReports({ reports }: { reports: SiteReport[] }) {
  const shown = reports.filter((r) => r.shown).length;
  const pendingPush = reports.some((r) => r.shown && r.articleDirty);
  return (
    <section className="mb-6 bg-white border border-slate-200 rounded-lg p-4">
      <div className="flex items-center gap-2">
        <Star size={14} className="fill-amber-400 text-amber-500" />
        <h2 className="text-sm font-semibold text-slate-800">ミーグリページに出るレポ</h2>
        <span className="text-xs text-slate-400">
          {shown} / {SITE_FEATURED_REPORTS_LIMIT}
        </span>
        {pendingPush && (
          <Link href="/articles/push" className="ml-auto text-xs text-amber-700 hover:underline">
            push 待ちの記事を含みます →
          </Link>
        )}
      </div>
      <p className="text-xs text-slate-500 mt-1">
        新しい回の記事から ★ の付いたレポを順に {SITE_FEATURED_REPORTS_LIMIT} 件。選ぶのは各回の「X レポ」の欄で行います。
      </p>
      {reports.length === 0 ? (
        <p className="mt-2 text-xs text-slate-400">★ の付いたレポがありません。</p>
      ) : (
        <ol className="mt-2 divide-y divide-slate-100">
          {reports.map((r, i) => (
            <li
              key={`${i}-${r.articleShortId}-${r.url}`}
              className={cn("flex items-center gap-3 py-1.5 text-sm", !r.shown && "opacity-50")}
            >
              <span className="w-5 shrink-0 text-right text-xs text-slate-400">{r.shown ? i + 1 : "–"}</span>
              <span className="w-20 shrink-0 text-xs text-slate-500">{r.date ?? ""}</span>
              <span className="min-w-0 flex-1 truncate text-slate-800">
                {r.tweet ? (
                  <>
                    <span className="text-xs text-slate-500">@{r.tweet.authorUsername}</span> {r.tweet.text}
                  </>
                ) : (
                  <span className="text-xs text-slate-400">{r.url}</span>
                )}
              </span>
              {r.articleDirty && <span className="shrink-0 text-[10px] text-amber-700">push 待ち</span>}
              {r.meetGreetId ? (
                <Link href={`/meetgreets/${r.meetGreetId}`} className="shrink-0 text-xs text-slate-500 hover:text-slate-800">
                  回を開く
                </Link>
              ) : (
                <Link href={`/articles/${r.articleShortId}`} className="shrink-0 text-xs text-slate-500 hover:text-slate-800">
                  記事を開く
                </Link>
              )}
              <a href={r.url} target="_blank" rel="noreferrer" className="shrink-0 text-slate-400 hover:text-slate-700" aria-label="X で開く">
                <ExternalLink size={13} />
              </a>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
