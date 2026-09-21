"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { MeetGreetKeeps } from "@/lib/domain/meetgreet-reports";
import { formatDate } from "@/lib/utils";
import { refetchReportsAction } from "../actions";
import { Lightbox } from "@/components/lightbox";

export function ReportsStep({
  meetGreetId,
  hasCollection,
  fetched,
  keeps,
}: {
  meetGreetId: string;
  hasCollection: boolean;
  /** 一度でも収集したか。まだなら「収集する」を主導線にする */
  fetched: boolean;
  /** 記事に載る予定のレポ (#135)。収集が見えないときは null */
  keeps: MeetGreetKeeps | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [zoom, setZoom] = useState<{ url: string; alt: string } | null>(null);

  if (!hasCollection) return null;

  function refetch() {
    setMsg("収集中… 1 分ほどかかることがあります");
    startTransition(async () => {
      const res = await refetchReportsAction(meetGreetId).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "通信に失敗しました",
      }));
      setMsg(res.ok ? `${res.fetched} 件取得、${res.added} 件追加` : `エラー: ${res.error}`);
      router.refresh();
    });
  }

  const shown = keeps?.tweets ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={refetch}
          disabled={pending}
          className={
            "inline-flex items-center gap-1 h-8 px-3 rounded-md text-xs disabled:opacity-50 " +
            (fetched
              ? "border border-slate-200 text-slate-700 hover:bg-slate-50"
              : "bg-slate-900 text-white hover:bg-slate-800")
          }
        >
          <RefreshCw size={12} className={pending ? "animate-spin" : ""} />
          {fetched ? "再収集" : "X を収集する"}
        </button>
        {msg && (
          <span role="status" className="text-xs text-slate-500">
            {msg}
          </span>
        )}
      </div>

      {keeps && !keeps.publishable && keeps.total > 0 && (
        <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          機密レベルが高いため、採用にしても記事の本文には載りません（記事は公開リポジトリに push されるため）。収集かミーグリの機密レベルを下げてください。
        </p>
      )}

      {keeps && keeps.total === 0 && fetched && (
        <p className="text-xs text-slate-500">
          採用にしたレポがまだありません。「レポを判定する」から選んでください。
        </p>
      )}

      {shown.length > 0 && (
        <div>
          <div className="text-xs font-medium text-slate-600 mb-1.5">
            記事に載るレポ（{keeps?.total} 件
            {keeps && keeps.total > shown.length ? `、うち ${shown.length} 件を表示` : ""}）
          </div>
          <ul className="max-h-[32rem] overflow-auto rounded-md border border-slate-200 divide-y divide-slate-100">
            {shown.map((t) => (
              <li key={t.id} className="p-3">
                <div className="flex items-baseline gap-2 flex-wrap text-xs">
                  <span className="font-semibold text-slate-800">{t.authorName}</span>
                  <span className="text-slate-500">@{t.authorUsername}</span>
                  {t.tweetedAt && (
                    <span className="text-slate-500">· {formatDate(t.tweetedAt, true)}</span>
                  )}
                  <a
                    href={t.url}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto inline-flex items-center gap-1 text-slate-500 hover:text-slate-800"
                  >
                    X で開く <ExternalLink size={11} />
                  </a>
                </div>
                {t.text && (
                  <p className="mt-1 text-xs text-slate-700 leading-relaxed whitespace-pre-wrap">
                    {t.text}
                  </p>
                )}
                {t.media.length > 0 && (
                  <ul className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
                    {t.media.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => setZoom({ url: m.url, alt: m.altText })}
                          className="block w-full aspect-square rounded-md overflow-hidden bg-slate-100 cursor-zoom-in"
                          aria-label={`${t.authorName} の写真を拡大`}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={m.url}
                            alt={m.altText}
                            className="w-full h-full object-cover"
                            loading="lazy"
                            decoding="async"
                          />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Lightbox src={zoom?.url ?? null} alt={zoom?.alt ?? ""} onClose={() => setZoom(null)} />
    </div>
  );
}
