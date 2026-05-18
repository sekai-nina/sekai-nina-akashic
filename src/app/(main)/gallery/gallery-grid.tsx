"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useSwipeable } from "react-swipeable";
import { Loader2, X, ChevronLeft, ChevronRight, Download, ExternalLink } from "lucide-react";
import Link from "next/link";

interface GalleryItem {
  id: string;
  title: string;
  kind: string;
  thumbnailUrl: string | null;
  storageKey: string | null;
  storageProvider: string | null;
  canonicalDate: string | null;
  createdAt: string;
}

type FilterKey = "all" | "blog" | "talk" | "image" | "video";

interface FilterOptions {
  blogEntityId: string | null;
  talkEntityId: string | null;
}

const FILTER_CHIPS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "すべて" },
  { key: "blog", label: "ブログ" },
  { key: "talk", label: "トーク" },
  { key: "image", label: "画像" },
  { key: "video", label: "動画" },
];

function formatMonth(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

function groupByMonth(items: GalleryItem[]): Map<string, GalleryItem[]> {
  const groups = new Map<string, GalleryItem[]>();
  for (const item of items) {
    const key = formatMonth(item.canonicalDate ?? item.createdAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  return groups;
}

export function GalleryGrid({
  initialItems,
  initialCursor,
  entityId,
  filterOptions,
}: {
  initialItems: GalleryItem[];
  initialCursor: string | null;
  entityId?: string;
  filterOptions: FilterOptions;
}) {
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const observerRef = useRef<HTMLDivElement>(null);

  const buildParams = useCallback(
    (extra?: Record<string, string>) => {
      const params = new URLSearchParams();
      const entityIds: string[] = [];
      if (entityId) entityIds.push(entityId);
      if (filter === "blog" && filterOptions.blogEntityId) entityIds.push(filterOptions.blogEntityId);
      if (filter === "talk" && filterOptions.talkEntityId) entityIds.push(filterOptions.talkEntityId);
      if (entityIds.length > 0) params.set("entityIds", entityIds.join(","));
      if (filter === "image") params.set("kind", "image");
      if (filter === "video") params.set("kind", "video");
      if (extra) {
        for (const [k, v] of Object.entries(extra)) params.set(k, v);
      }
      return params;
    },
    [entityId, filter, filterOptions.blogEntityId, filterOptions.talkEntityId]
  );

  const loadMore = useCallback(async () => {
    if (loading || !cursor) return;
    setLoading(true);
    try {
      const params = buildParams({ cursor });
      const res = await fetch(`/api/gallery?${params}`);
      const data = await res.json();
      setItems((prev) => [...prev, ...data.items]);
      setCursor(data.nextCursor);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, [buildParams, cursor, loading]);

  // Re-fetch from scratch when filter changes (skip on initial mount)
  const isFirstFilterRun = useRef(true);
  useEffect(() => {
    if (isFirstFilterRun.current) {
      isFirstFilterRun.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const params = buildParams();
      try {
        const res = await fetch(`/api/gallery?${params}`);
        const data = await res.json();
        if (cancelled) return;
        setItems(data.items);
        setCursor(data.nextCursor);
      } catch {
        // Ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filter, buildParams]);

  // Infinite scroll
  useEffect(() => {
    const el = observerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore();
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  // Lightbox keyboard navigation
  useEffect(() => {
    if (lightbox === null) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setLightbox(null);
      if (e.key === "ArrowRight") setLightbox((i) => i !== null && i < items.length - 1 ? i + 1 : i);
      if (e.key === "ArrowLeft") setLightbox((i) => i !== null && i > 0 ? i - 1 : i);
    }
    document.addEventListener("keydown", handleKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = "";
    };
  }, [lightbox, items.length]);

  const swipeHandlers = useSwipeable({
    onSwipedLeft: () =>
      setLightbox((i) => (i !== null && i < items.length - 1 ? i + 1 : i)),
    onSwipedRight: () => setLightbox((i) => (i !== null && i > 0 ? i - 1 : i)),
    trackTouch: true,
    trackMouse: false,
    delta: 40,
  });

  const groups = groupByMonth(items);
  const hasBlog = !!filterOptions.blogEntityId;
  const hasTalk = !!filterOptions.talkEntityId;
  const visibleChips = FILTER_CHIPS.filter((c) => {
    if (c.key === "blog") return hasBlog;
    if (c.key === "talk") return hasTalk;
    return true;
  });

  function getGalleryImageUrl(item: GalleryItem): string {
    // R2 サムネイルがあればそれを使う
    if (item.thumbnailUrl?.includes("/thumbnails/")) return item.thumbnailUrl;
    // Drive 画像はプロキシ経由で表示
    if (item.storageProvider === "gdrive" && item.storageKey) {
      return `/api/drive-image/${item.storageKey}`;
    }
    return item.thumbnailUrl ?? "";
  }

  function getDownloadUrl(item: GalleryItem): string | null {
    if (item.storageProvider === "gdrive" && item.storageKey) {
      return `/api/drive-image/${item.storageKey}?download=1`;
    }
    return null;
  }

  return (
    <>
      {/* Filter chips */}
      <div className="mb-4 flex gap-1.5 flex-wrap">
        {visibleChips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => setFilter(chip.key)}
            className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
              filter === chip.key
                ? "bg-blue-600 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {loading && items.length === 0 ? (
        <div className="py-16 flex justify-center">
          <Loader2 size={24} className="animate-spin text-slate-400" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <p>画像がありません</p>
        </div>
      ) : (
        <div className="space-y-8">
          {[...groups.entries()].map(([month, groupItems]) => (
            <div key={month}>
              <h2 className="text-sm font-semibold text-slate-500 mb-3 sticky top-0 bg-slate-50 py-1 z-[1] backdrop-blur-sm border-b border-slate-200/50">
                {month}
              </h2>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-1.5">
                {groupItems.map((item) => {
                  const idx = items.indexOf(item);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setLightbox(idx)}
                      className="aspect-square overflow-hidden rounded bg-slate-100 hover:opacity-80 transition-opacity relative group"
                    >
                      {item.thumbnailUrl && (
                        <img
                          src={item.thumbnailUrl}
                          alt={item.title}
                          loading="lazy"
                          className="w-full h-full object-cover"
                        />
                      )}
                      {item.kind === "video" && (
                        <span className="absolute bottom-1 right-1 bg-black/60 text-white text-xs px-1 rounded">
                          動画
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Load more trigger */}
      <div ref={observerRef} className="py-8 flex justify-center">
        {loading && items.length > 0 && <Loader2 size={20} className="animate-spin text-slate-400" />}
      </div>

      {/* Lightbox */}
      {lightbox !== null && items[lightbox] && (
        <div
          {...swipeHandlers}
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center select-none touch-pan-y"
        >
          {/* Close */}
          <button
            type="button"
            onClick={() => setLightbox(null)}
            aria-label="閉じる"
            className="absolute top-4 right-4 text-white/70 hover:text-white z-10 p-2 -m-2"
          >
            <X size={28} />
          </button>

          {/* Nav (desktop) */}
          {lightbox > 0 && (
            <button
              type="button"
              onClick={() => setLightbox(lightbox - 1)}
              aria-label="前へ"
              className="hidden sm:block absolute left-4 text-white/50 hover:text-white z-10 p-2"
            >
              <ChevronLeft size={32} />
            </button>
          )}
          {lightbox < items.length - 1 && (
            <button
              type="button"
              onClick={() => setLightbox(lightbox + 1)}
              aria-label="次へ"
              className="hidden sm:block absolute right-4 text-white/50 hover:text-white z-10 p-2"
            >
              <ChevronRight size={32} />
            </button>
          )}

          {/* Image */}
          <img
            src={getGalleryImageUrl(items[lightbox])}
            alt={items[lightbox].title}
            className="max-h-[90vh] max-w-[90vw] object-contain pointer-events-none"
            draggable={false}
          />

          {/* Info bar */}
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-14">
            <p className="text-white text-sm font-medium truncate">
              {items[lightbox].title || "(無題)"}
            </p>
            <p className="text-white/60 text-xs mt-0.5">
              {new Date(items[lightbox].canonicalDate ?? items[lightbox].createdAt).toLocaleDateString("ja-JP")}
            </p>
            <div className="flex items-center gap-2 mt-3">
              <Link
                href={`/assets/${items[lightbox].id}`}
                className="inline-flex items-center gap-1.5 bg-white/10 hover:bg-white/20 active:bg-white/30 text-white text-sm font-medium rounded-full px-4 py-2 transition-colors"
                onClick={() => setLightbox(null)}
              >
                <ExternalLink size={16} />
                詳細を見る
              </Link>
              {getDownloadUrl(items[lightbox]) && (
                <a
                  href={getDownloadUrl(items[lightbox])!}
                  className="inline-flex items-center gap-1.5 bg-white/10 hover:bg-white/20 active:bg-white/30 text-white text-sm font-medium rounded-full px-4 py-2 transition-colors"
                  download
                >
                  <Download size={16} />
                  原寸DL
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
