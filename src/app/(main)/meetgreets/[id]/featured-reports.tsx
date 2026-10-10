"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ExternalLink, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { setReportFeaturedAction } from "../actions";
import type { MeetGreetArticleReports } from "@/lib/domain/meetgreet-featured";

/**
 * 記事に載っているレポのうち、世界新奈の `/meetgreet` に出すものを選ぶ (#210)。
 * ★ は記事本文の `![rep]` そのもの。押すと記事が push 待ちになり、push でサイトに出る。
 */
export function FeaturedReports({ id, data }: { id: string; data: MeetGreetArticleReports }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const count = data.reports.filter((r) => r.featured).length;

  function toggle(tweetId: string, on: boolean) {
    setBusy(tweetId);
    startTransition(async () => {
      const res = await setReportFeaturedAction(id, tweetId, on);
      setBusy(null);
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setMsg(null);
      router.refresh();
    });
  }

  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold text-slate-600">ミーグリページに出すレポ</h3>
        <span className="text-xs text-slate-400">記事のレポ {data.reports.length} 件中 {count} 件</span>
        {data.dirty && (
          <Link href="/articles/push" className="ml-auto text-xs text-amber-700 hover:underline">
            push 待ち →
          </Link>
        )}
      </div>
      <p className="text-xs text-slate-500 mt-1">
        ★ を付けたレポが世界新奈の /meetgreet に出ます (新しい回から順に 9 件)。押すと記事本文の印が変わり、記事を push するとサイトに反映されます。
      </p>
      {data.reports.length === 0 ? (
        <p className="mt-2 text-xs text-slate-400">記事にレポが載っていません。</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100">
          {data.reports.map((r) => (
            <li key={r.tweetId} className="flex items-start gap-2 py-2">
              <button
                type="button"
                onClick={() => toggle(r.tweetId, !r.featured)}
                disabled={pending}
                aria-pressed={r.featured}
                aria-label={r.featured ? "ミーグリページから外す" : "ミーグリページに出す"}
                className={cn(
                  "mt-0.5 shrink-0 rounded p-1 hover:bg-slate-100 disabled:opacity-50",
                  busy === r.tweetId && "animate-pulse"
                )}
              >
                <Star size={16} className={r.featured ? "fill-amber-400 text-amber-500" : "text-slate-300"} />
              </button>
              <div className="min-w-0 flex-1 text-sm">
                {r.tweet ? (
                  <>
                    <p className="text-xs text-slate-500">
                      {r.tweet.authorName} <span className="text-slate-400">@{r.tweet.authorUsername}</span>
                    </p>
                    <p className="text-slate-800 whitespace-pre-wrap line-clamp-3">{r.tweet.text}</p>
                  </>
                ) : (
                  <p className="text-xs text-slate-400">ツイートの中身は収集にありません</p>
                )}
              </div>
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-slate-400 hover:text-slate-700"
                aria-label="X で開く"
              >
                <ExternalLink size={14} />
              </a>
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="mt-1 text-xs text-red-600">{msg}</p>}
    </div>
  );
}
