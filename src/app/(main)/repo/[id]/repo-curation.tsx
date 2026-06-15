"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { RepoTweetStatus } from "@prisma/client";
import {
  setTweetStatusAction,
  bulkSetStatusAction,
  fetchCollectionAction,
  exportCollectionAction,
} from "../actions";

type Status = "undecided" | "keep" | "reject";

interface Media {
  id: string;
  type: string;
  imageUrl: string | null;
  altText: string;
}
interface Tweet {
  id: string;
  tweetId: string;
  authorUsername: string;
  authorName: string;
  text: string;
  tweetedAt: string | null;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  quoteCount: number;
  url: string;
  status: Status;
  media: Media[];
}

type Filter = "all" | Status;
type Sort = "newest" | "oldest" | "likes";

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function RepoCuration({
  collection,
  tweets: initialTweets,
}: {
  collection: { id: string; name: string; query: string };
  tweets: Tweet[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [tweets, setTweets] = useState<Tweet[]>(initialTweets);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [selIdx, setSelIdx] = useState(0);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // 追加収集などでサーバ側データが更新されたら同期
  useEffect(() => {
    setTweets(initialTweets);
  }, [initialTweets]);

  const showToast = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(null), 2400);
  }, []);

  const visible = useMemo(() => {
    const filtered =
      filter === "all" ? tweets : tweets.filter((t) => t.status === filter);
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sort === "likes") return b.likeCount - a.likeCount;
      const ta = a.tweetedAt ? Date.parse(a.tweetedAt) : 0;
      const tb = b.tweetedAt ? Date.parse(b.tweetedAt) : 0;
      return sort === "oldest" ? ta - tb : tb - ta;
    });
    return sorted;
  }, [tweets, filter, sort]);

  useEffect(() => {
    setSelIdx((i) => Math.min(i, Math.max(0, visible.length - 1)));
  }, [visible.length]);

  const setStatus = useCallback(
    (tweetRowId: string, status: Status) => {
      setTweets((ts) => ts.map((t) => (t.id === tweetRowId ? { ...t, status } : t)));
      startTransition(async () => {
        await setTweetStatusAction(tweetRowId, status as RepoTweetStatus);
      });
    },
    []
  );

  const handleFetch = useCallback(() => {
    setFetching(true);
    startTransition(async () => {
      const r = await fetchCollectionAction(collection.id);
      setFetching(false);
      if (!r.ok) showToast(`エラー: ${r.error}`);
      else showToast(`${r.added} 件追加 / 画像 ${r.mediaSaved} 枚`);
      router.refresh();
    });
  }, [collection.id, router, showToast]);

  const handleRejectRest = useCallback(() => {
    if (!window.confirm("未選別のツイートをすべて却下しますか？")) return;
    setTweets((ts) =>
      ts.map((t) => (t.status === "undecided" ? { ...t, status: "reject" } : t))
    );
    startTransition(async () => {
      await bulkSetStatusAction(
        collection.id,
        "undecided" as RepoTweetStatus,
        "reject" as RepoTweetStatus
      );
      showToast("未選別を却下しました");
      router.refresh();
    });
  }, [collection.id, router, showToast]);

  // keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (["input", "textarea", "select"].includes(tag)) return;
      if (lightbox) {
        if (e.key === "Escape") setLightbox(null);
        return;
      }
      if (visible.length === 0) return;
      const cur = visible[selIdx];
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelIdx((i) => Math.min(i + 1, visible.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "k" && cur) {
        setStatus(cur.id, "keep");
      } else if (e.key === "r" && cur) {
        setStatus(cur.id, "reject");
      } else if (e.key === "u" && cur) {
        setStatus(cur.id, "undecided");
      } else if (e.key === "o" && cur) {
        window.open(cur.url, "_blank");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, selIdx, lightbox, setStatus]);

  // scroll selected into view
  useEffect(() => {
    const el = document.getElementById(`tw-${selIdx}`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selIdx]);

  return (
    <div className="max-w-3xl mx-auto">
      <Link href="/repo" className="text-sm text-slate-500 hover:underline">
        ← 一覧に戻る
      </Link>
      <h1 className="text-xl font-bold text-slate-900 mt-2">{collection.name}</h1>
      <p className="text-xs text-slate-400 mb-4 break-all">{collection.query}</p>

      <div className="flex gap-2 items-center flex-wrap mb-2">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
          className="text-sm px-3 py-1.5 rounded-md border border-slate-200 bg-white"
        >
          <option value="all">すべて</option>
          <option value="undecided">未選別</option>
          <option value="keep">採用</option>
          <option value="reject">却下</option>
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          className="text-sm px-3 py-1.5 rounded-md border border-slate-200 bg-white"
        >
          <option value="newest">新しい順</option>
          <option value="oldest">古い順</option>
          <option value="likes">いいね順</option>
        </select>
        <button
          onClick={handleFetch}
          disabled={fetching}
          className="text-sm px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100 disabled:opacity-50"
        >
          {fetching ? "収集中…" : "追加収集"}
        </button>
        <button
          onClick={handleRejectRest}
          className="text-sm px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100"
        >
          未選別を全却下
        </button>
        <div className="flex-1" />
        <ExportButton collectionId={collection.id} />
      </div>
      <p className="text-xs text-slate-400 mb-3">
        キーボード: <b>↑/↓</b> 移動・<b>k</b>採用・<b>r</b>却下・<b>u</b>戻す・<b>o</b>ツイートを開く
      </p>

      {visible.length === 0 ? (
        <p className="text-slate-400 py-10 text-center text-sm">
          該当ツイートなし。「追加収集」を試してください。
        </p>
      ) : (
        <div className="space-y-2.5">
          {visible.map((t, i) => (
            <TweetCard
              key={t.id}
              tweet={t}
              selected={i === selIdx}
              domId={`tw-${i}`}
              onSelect={() => setSelIdx(i)}
              onStatus={(s) => setStatus(t.id, s)}
              onImage={(src) => setLightbox(src)}
            />
          ))}
        </div>
      )}

      {lightbox && (
        <div
          className="fixed inset-0 bg-black/85 flex items-center justify-center z-50 p-5 cursor-zoom-out"
          onClick={() => setLightbox(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="" className="max-w-[96vw] max-h-[96vh] rounded-lg" />
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
}

function TweetCard({
  tweet: t,
  selected,
  domId,
  onSelect,
  onStatus,
  onImage,
}: {
  tweet: Tweet;
  selected: boolean;
  domId: string;
  onSelect: () => void;
  onStatus: (s: Status) => void;
  onImage: (src: string) => void;
}) {
  const border =
    t.status === "keep"
      ? "border-green-300"
      : t.status === "reject"
        ? "border-red-200 opacity-60"
        : "border-slate-200";
  return (
    <div
      id={domId}
      onClick={onSelect}
      className={`border rounded-lg p-4 bg-white ${border} ${
        selected ? "ring-2 ring-slate-900" : ""
      }`}
    >
      <div className="flex items-center gap-2 text-sm mb-1.5 flex-wrap">
        <span className="font-semibold text-slate-900">{t.authorName}</span>
        <span className="text-slate-400">@{t.authorUsername}</span>
        <span className="text-slate-400">· {fmtDate(t.tweetedAt)}</span>
      </div>
      <div className="text-sm text-slate-800 whitespace-pre-wrap leading-relaxed mb-2">
        {t.text}
      </div>
      {t.media.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {t.media.map((m) =>
            m.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={m.id}
                src={m.imageUrl}
                alt={m.altText}
                loading="lazy"
                onClick={(e) => {
                  e.stopPropagation();
                  onImage(m.imageUrl!);
                }}
                className="max-h-60 max-w-full rounded-md border border-slate-200 cursor-zoom-in object-cover"
              />
            ) : null
          )}
        </div>
      )}
      <div className="flex items-center gap-3 text-xs text-slate-400 flex-wrap">
        <span>♥ {t.likeCount}</span>
        <span>🔁 {t.retweetCount}</span>
        <span>💬 {t.replyCount}</span>
        <a
          href={t.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-blue-500 hover:underline"
        >
          ツイートを開く ↗
        </a>
      </div>
      <div className="flex gap-1.5 mt-3">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onStatus("keep");
          }}
          className="px-3 py-1 text-xs rounded bg-green-50 text-green-700 hover:bg-green-100"
        >
          採用
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onStatus("reject");
          }}
          className="px-3 py-1 text-xs rounded bg-red-50 text-red-700 hover:bg-red-100"
        >
          却下
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onStatus("undecided");
          }}
          className="px-3 py-1 text-xs rounded bg-slate-100 text-slate-600 hover:bg-slate-200"
        >
          戻す
        </button>
      </div>
    </div>
  );
}

function ExportButton({ collectionId }: { collectionId: string }) {
  const [open, setOpen] = useState(false);
  const [fmt, setFmt] = useState<"links" | "markdown" | "csv">("links");
  const [text, setText] = useState("");
  const [, startTransition] = useTransition();
  const taRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(
    (f: "links" | "markdown" | "csv") => {
      setFmt(f);
      startTransition(async () => {
        setText(await exportCollectionAction(collectionId, f));
      });
    },
    [collectionId]
  );

  function openModal() {
    setOpen(true);
    load("links");
  }

  return (
    <>
      <button
        onClick={openModal}
        className="text-sm px-3 py-1.5 rounded-md bg-green-600 text-white hover:bg-green-700"
      >
        採用をエクスポート
      </button>
      {open && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center p-5 z-50"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="bg-white rounded-xl p-5 max-w-2xl w-full max-h-[80vh] overflow-auto">
            <h2 className="text-base font-semibold text-slate-900 mb-3">
              採用ツイートのエクスポート
            </h2>
            <div className="flex gap-2 items-center mb-3">
              {(["links", "markdown", "csv"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => load(f)}
                  className={`text-xs px-3 py-1 rounded-md border ${
                    fmt === f
                      ? "bg-slate-900 text-white border-slate-900"
                      : "border-slate-200 text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {f === "links" ? "リンクのみ" : f === "markdown" ? "Markdown" : "CSV"}
                </button>
              ))}
              <div className="flex-1" />
              <button
                onClick={() => {
                  taRef.current?.select();
                  navigator.clipboard.writeText(text);
                }}
                className="text-xs px-3 py-1 rounded-md bg-slate-900 text-white hover:bg-slate-900/90"
              >
                コピー
              </button>
              <button
                onClick={() => setOpen(false)}
                className="text-xs px-3 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100"
              >
                閉じる
              </button>
            </div>
            <textarea
              ref={taRef}
              readOnly
              value={text}
              className="w-full h-72 font-mono text-xs p-3 border border-slate-200 rounded-md bg-slate-50 text-slate-800"
            />
          </div>
        </div>
      )}
    </>
  );
}
