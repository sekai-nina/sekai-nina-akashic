"use client";

import { useState, useTransition, useEffect, useRef } from "react";
import { Plus, X, ExternalLink, Trash2, MapPin, BadgeCheck, Search, Loader2, Link2 } from "lucide-react";
import { DynamicMap } from "@/components/dynamic-map";
import {
  addPlaceCandidateAction,
  removePlaceCandidateAction,
  promotePlaceCandidateAction,
} from "../actions";

type Candidate = {
  id: string;
  placeId: string | null;
  name: string;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  googleMapsUrl: string | null;
  note: string;
  confidence: number;
  place: {
    id: string;
    status: string;
    entity: { canonicalName: string };
  } | null;
};

interface PlaceCandidateListProps {
  dossierId: string;
  candidates: Candidate[];
  editable: boolean;
}

type PlaceSearchResult = {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  googleMapsUrl: string;
};

export function PlaceCandidateList({ dossierId, candidates, editable }: PlaceCandidateListProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [googleMapsUrl, setGoogleMapsUrl] = useState("");
  const [note, setNote] = useState("");
  const [confidence, setConfidence] = useState("0");
  const [isPending, startTransition] = useTransition();

  // Google Places search
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
          if (res.status === 503) setSearchError("Google Places APIキーが未設定です");
          else setSearchError("検索に失敗しました");
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

  function selectSearchResult(r: PlaceSearchResult) {
    setName(r.name);
    setAddress(r.address);
    setLatitude(String(r.lat));
    setLongitude(String(r.lng));
    setGoogleMapsUrl(r.googleMapsUrl);
    setSearchQuery("");
    setSearchResults([]);
  }

  // Resolve Google Maps URL → coords
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
        if (res.status === 422) setResolveError("URLから緯度経度を抽出できませんでした");
        else setResolveError("URL解決に失敗しました");
        return;
      }
      const data = (await res.json()) as { lat: number; lng: number; name: string; googleMapsUrl: string };
      setLatitude(String(data.lat));
      setLongitude(String(data.lng));
      if (!name && data.name) setName(data.name);
      if (data.googleMapsUrl && data.googleMapsUrl !== trimmed) setGoogleMapsUrl(data.googleMapsUrl);
    } catch {
      setResolveError("URL解決に失敗しました");
    } finally {
      setResolving(false);
    }
  }

  function add() {
    if (!name && !address && !latitude) return;
    const fd = new FormData();
    fd.set("name", name);
    fd.set("address", address);
    if (latitude) fd.set("latitude", latitude);
    if (longitude) fd.set("longitude", longitude);
    fd.set("googleMapsUrl", googleMapsUrl);
    fd.set("note", note);
    fd.set("confidence", confidence);
    startTransition(async () => {
      await addPlaceCandidateAction(dossierId, fd);
      setName("");
      setAddress("");
      setLatitude("");
      setLongitude("");
      setGoogleMapsUrl("");
      setNote("");
      setConfidence("0");
      setSearchQuery("");
      setSearchResults([]);
      setSearchError(null);
      setResolveError(null);
      setOpen(false);
    });
  }

  function remove(id: string) {
    if (!confirm("この候補を削除しますか？")) return;
    startTransition(() => removePlaceCandidateAction(id, dossierId));
  }

  function promote(c: Candidate) {
    if (c.place && c.place.status === "confirmed") return;
    if (!c.place && (c.latitude == null || c.longitude == null)) {
      alert("確定にするには緯度・経度が必要です");
      return;
    }
    const label = c.place?.entity.canonicalName ?? c.name ?? "(無題)";
    if (!confirm(`「${label}」を聖地として確定しますか？`)) return;
    startTransition(async () => {
      await promotePlaceCandidateAction(c.id, dossierId);
    });
  }

  const mapMarkers = candidates
    .filter((c) => c.latitude != null && c.longitude != null)
    .map((c) => ({
      id: c.id,
      lat: c.latitude!,
      lng: c.longitude!,
      label: c.place?.entity.canonicalName ?? c.name ?? "(無題)",
      popupHtml: c.address
        ? `<strong>${c.place?.entity.canonicalName ?? c.name ?? ""}</strong><br/>${c.address}`
        : undefined,
    }));

  return (
    <div className="space-y-2">
      {mapMarkers.length > 0 && (
        <div className="rounded-lg overflow-hidden border border-slate-200">
          <DynamicMap markers={mapMarkers} />
        </div>
      )}

      {candidates.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {candidates.map((c) => {
            const isConfirmed = c.place?.status === "confirmed";
            return (
              <li key={c.id} className="bg-white border border-slate-200 rounded p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900 truncate flex items-center gap-1">
                      <MapPin className="h-3 w-3 text-slate-400 shrink-0" />
                      {c.place?.entity.canonicalName ?? c.name ?? "(無題)"}
                      {isConfirmed && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] bg-emerald-100 text-emerald-700 px-1 rounded">
                          <BadgeCheck className="h-2.5 w-2.5" /> 確定
                        </span>
                      )}
                    </p>
                    {c.address && <p className="text-[11px] text-slate-500 truncate">{c.address}</p>}
                    {c.note && <p className="text-[11px] text-slate-600 mt-1">{c.note}</p>}
                  </div>
                  <div className="shrink-0 flex flex-col items-end gap-1">
                    <span className="text-[10px] text-slate-400">確度 {c.confidence}</span>
                    {c.googleMapsUrl && (
                      <a
                        href={c.googleMapsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-500 hover:text-indigo-700"
                        title="地図"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    {editable && !isConfirmed && (
                      <button
                        type="button"
                        onClick={() => promote(c)}
                        disabled={isPending}
                        className="text-emerald-500 hover:text-emerald-700 disabled:opacity-40"
                        title="聖地として確定"
                      >
                        <BadgeCheck className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {editable && (
                      <button
                        type="button"
                        onClick={() => remove(c.id)}
                        className="text-rose-400 hover:text-rose-600"
                        title="削除"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editable && !open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline"
        >
          <Plus className="h-3.5 w-3.5" /> 候補を追加
        </button>
      )}

      {editable && open && (
        <div className="bg-white border border-slate-200 rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-slate-600">場所候補を追加</h3>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-slate-400 hover:text-slate-600"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Place search */}
          <div className="relative mb-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="店名・施設名で検索 (例: スターバックス 渋谷)"
                className="w-full pl-7 pr-7 border border-slate-300 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              {searching && (
                <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 animate-spin" />
              )}
            </div>
            {searchError && (
              <p className="mt-1 text-[10px] text-rose-500">{searchError}</p>
            )}
            {searchResults.length > 0 && (
              <ul className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded shadow-lg max-h-64 overflow-y-auto">
                {searchResults.map((r) => (
                  <li key={r.placeId || `${r.lat},${r.lng}`}>
                    <button
                      type="button"
                      onClick={() => selectSearchResult(r)}
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

          {/* URL paste */}
          <div className="mb-2">
            <div className="relative">
              <Link2 className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <input
                value={googleMapsUrl}
                onChange={(e) => setGoogleMapsUrl(e.target.value)}
                onBlur={(e) => {
                  if (e.target.value && !latitude) resolveUrl(e.target.value);
                }}
                onPaste={(e) => {
                  const v = e.clipboardData.getData("text");
                  if (v) setTimeout(() => resolveUrl(v), 0);
                }}
                placeholder="または Google Maps URL を貼り付け (短縮URL対応)"
                className="w-full pl-7 pr-7 border border-slate-300 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              {resolving && (
                <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 animate-spin" />
              )}
            </div>
            {resolveError && (
              <p className="mt-1 text-[10px] text-rose-500">{resolveError}</p>
            )}
          </div>

          <div className="border-t border-slate-100 pt-2 mt-2">
            <p className="text-[10px] text-slate-400 mb-1.5">詳細・微修正</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="店名/場所名"
                className="border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="住所"
                className="border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <input
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
                placeholder="緯度"
                type="number"
                step="0.000001"
                className="border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <input
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
                placeholder="経度"
                type="number"
                step="0.000001"
                className="border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <input
                value={confidence}
                onChange={(e) => setConfidence(e.target.value)}
                placeholder="確度 (0-100)"
                type="number"
                min="0"
                max="100"
                className="border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="メモ"
                className="border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={add}
              disabled={isPending}
              className="bg-indigo-600 text-white px-3 py-1 rounded text-xs font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              追加
            </button>
          </div>
        </div>
      )}

      {candidates.length === 0 && !open && (
        <p className="text-xs text-slate-400">候補はまだありません。</p>
      )}
    </div>
  );
}
