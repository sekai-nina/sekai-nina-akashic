"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Loader2, X, ChevronLeft, ChevronRight, Download } from "lucide-react";
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
}: {
  initialItems: GalleryItem[];
  initialCursor: string | null;
}) {
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const observerRef = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(async () => {
    if (loading || !cursor) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/gallery?cursor=${cursor}`);
      const data = await res.json();
      setItems((prev) => [...prev, ...data.items]);
      setCursor(data.nextCursor);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, [cursor, loading]);

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

  const groups = groupByMonth(items);

  function getGalleryImageUrl(item: GalleryItem): string {
    // Use R2 thumbnail (640px webp) for viewing — fast and sufficient quality
    if (item.thumbnailUrl) return item.thumbnailUrl;
    if (item.storageProvider === "gdrive" && item.storageKey) {
      return `/api/drive-image/${item.storageKey}`;
    }
    return "";
  }

  function getDownloadUrl(item: GalleryItem): string | null {
    if (item.storageProvider === "gdrive" && item.storageKey) {
      return `/api/drive-image/${item.storageKey}?download=1`;
    }
    return null;
  }

  return (
    <>
      {items.length === 0 ? (
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
        {loading && <Loader2 size={20} className="animate-spin text-slate-400" />}
      </div>

      {/* Lightbox */}
      {lightbox !== null && items[lightbox] && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center">
          {/* Close */}
          <button
            type="button"
            onClick={() => setLightbox(null)}
            className="absolute top-4 right-4 text-white/70 hover:text-white z-10"
          >
            <X size={24} />
          </button>

          {/* Nav */}
          {lightbox > 0 && (
            <button
              type="button"
              onClick={() => setLightbox(lightbox - 1)}
              className="absolute left-4 text-white/50 hover:text-white z-10"
            >
              <ChevronLeft size={32} />
            </button>
          )}
          {lightbox < items.length - 1 && (
            <button
              type="button"
              onClick={() => setLightbox(lightbox + 1)}
              className="absolute right-4 text-white/50 hover:text-white z-10"
            >
              <ChevronRight size={32} />
            </button>
          )}

          {/* Image */}
          <img
            src={getGalleryImageUrl(items[lightbox])}
            alt={items[lightbox].title}
            className="max-h-[90vh] max-w-[90vw] object-contain"
          />

          {/* Info bar */}
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-4 pt-12">
            <p className="text-white text-sm font-medium truncate">
              {items[lightbox].title || "(無題)"}
            </p>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-white/60 text-xs">
                {new Date(items[lightbox].canonicalDate ?? items[lightbox].createdAt).toLocaleDateString("ja-JP")}
              </span>
              {getDownloadUrl(items[lightbox]) && (
                <a
                  href={getDownloadUrl(items[lightbox])!}
                  className="text-white/60 hover:text-white text-xs flex items-center gap-1"
                  download
                >
                  <Download size={12} />
                  原寸DL
                </a>
              )}
              <Link
                href={`/assets/${items[lightbox].id}`}
                className="text-blue-400 text-xs hover:text-blue-300"
                onClick={() => setLightbox(null)}
              >
                詳細を見る →
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
