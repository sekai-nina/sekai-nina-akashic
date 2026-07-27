"use client";

import { useEffect, useRef, useState } from "react";
import { Link2, Loader2, Search } from "lucide-react";

export interface PlaceSearchResult {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  googleMapsUrl: string;
}

/** 検索結果の選択、または URL 解決で判明した内容 */
export interface ResolvedPlace {
  name?: string;
  address?: string;
  lat?: number;
  lng?: number;
  googleMapsUrl?: string;
}

interface PlaceLookupProps {
  /** Google Maps URL 欄の値（保持は呼び出し側） */
  googleMapsUrl: string;
  onGoogleMapsUrlChange: (url: string) => void;
  /** 場所が特定できたときに呼ばれる。渡された項目だけ埋める */
  onResolved: (place: ResolvedPlace) => void;
  /** すでに緯度経度が入っているか。入力済みなら blur での自動解決はしない */
  hasCoordinates: boolean;
  size?: "sm" | "md";
}

/**
 * 店名検索（Google Places）と Google Maps URL からの座標解決。
 * 聖地の新規登録とドシエの場所候補で共有する。
 */
export function PlaceLookup({
  googleMapsUrl,
  onGoogleMapsUrlChange,
  onResolved,
  hasCoordinates,
  size = "md",
}: PlaceLookupProps) {
  const compact = size === "sm";
  const inputClass = compact
    ? "w-full pl-7 pr-7 border border-slate-300 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
    : "w-full pl-9 pr-9 border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500";
  const iconClass = compact
    ? "absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400"
    : "absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400";
  const spinnerClass = compact
    ? "absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 animate-spin"
    : "absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 animate-spin";
  const errorClass = compact ? "mt-1 text-[10px] text-rose-500" : "mt-1 text-xs text-rose-500";

  // Google Places 検索
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PlaceSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setSearchError(null);
      return;
    }
    searchDebounce.current = setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const res = await fetch(`/api/v1/places/search?q=${encodeURIComponent(searchQuery)}`);
        if (!res.ok) {
          if (res.status === 503) {
            setSearchError("Google Places APIキーが未設定です。URL の貼り付けは使えます");
          } else {
            setSearchError("検索に失敗しました");
          }
          setSearchResults([]);
          return;
        }
        const data = (await res.json()) as { results: PlaceSearchResult[] };
        setSearchResults(data.results);
      } catch {
        setSearchError("検索に失敗しました");
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => {
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
    };
  }, [searchQuery]);

  // Google Maps URL → 座標
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  async function resolveUrl(url: string) {
    const trimmed = url.trim();
    if (!trimmed) return;
    setResolving(true);
    setResolveError(null);
    try {
      const res = await fetch(`/api/v1/places/resolve-url?url=${encodeURIComponent(trimmed)}`);
      if (!res.ok) {
        setResolveError(
          res.status === 422 ? "URLから緯度経度を抽出できませんでした" : "URL解決に失敗しました"
        );
        return;
      }
      const data = (await res.json()) as {
        lat: number;
        lng: number;
        name: string;
        googleMapsUrl: string;
      };
      onResolved({
        lat: data.lat,
        lng: data.lng,
        name: data.name || undefined,
        googleMapsUrl:
          data.googleMapsUrl && data.googleMapsUrl !== trimmed ? data.googleMapsUrl : undefined,
      });
    } catch {
      setResolveError("URL解決に失敗しました");
    } finally {
      setResolving(false);
    }
  }

  return (
    <>
      <div className={`relative ${compact ? "mb-2" : ""}`}>
        <div className="relative">
          <Search className={iconClass} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="店名・施設名で検索 (例: スターバックス 渋谷)"
            className={inputClass}
          />
          {searching && <Loader2 className={spinnerClass} />}
        </div>
        {searchError && <p className={errorClass}>{searchError}</p>}
        {searchResults.length > 0 && (
          <ul className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded shadow-lg max-h-64 overflow-y-auto">
            {searchResults.map((r) => (
              <li key={r.placeId || `${r.lat},${r.lng}`}>
                <button
                  type="button"
                  onClick={() => {
                    onResolved({
                      name: r.name,
                      address: r.address,
                      lat: r.lat,
                      lng: r.lng,
                      googleMapsUrl: r.googleMapsUrl,
                    });
                    setSearchQuery("");
                    setSearchResults([]);
                  }}
                  className="w-full text-left px-2 py-1.5 hover:bg-indigo-50 border-b border-slate-100 last:border-b-0"
                >
                  <p className="text-xs font-medium text-slate-900 truncate">{r.name}</p>
                  <p className="text-[10px] text-slate-500 truncate">{r.address}</p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={compact ? "mb-2" : ""}>
        <div className="relative">
          <Link2 className={iconClass} />
          <input
            type="text"
            value={googleMapsUrl}
            onChange={(e) => onGoogleMapsUrlChange(e.target.value)}
            onBlur={(e) => {
              if (e.target.value && !hasCoordinates) resolveUrl(e.target.value);
            }}
            onPaste={(e) => {
              const v = e.clipboardData.getData("text");
              if (v) setTimeout(() => resolveUrl(v), 0);
            }}
            placeholder="または Google Maps URL を貼り付け (短縮URL対応)"
            className={inputClass}
          />
          {resolving && <Loader2 className={spinnerClass} />}
        </div>
        {resolveError && <p className={errorClass}>{resolveError}</p>}
      </div>
    </>
  );
}
