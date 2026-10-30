"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Plus, X, ExternalLink, Trash2, MapPin, BadgeCheck } from "lucide-react";
import { DynamicMap } from "@/components/dynamic-map";
import { PlaceLookup } from "@/components/place-lookup";
import { PLACE_CLASSIFICATION_LABELS } from "@/lib/utils";
import type { ClearanceLevel } from "@prisma/client";
import {
  addPlaceCandidateAction,
  removePlaceCandidateAction,
  promotePlaceCandidateAction,
  updateCandidatePlaceClassificationAction,
} from "../actions";
import { DeleteConfirm } from "./delete-confirm";

/** カード下の操作ボタン。スマホでは指で押せる高さにする */
const ACTION_BUTTON =
  "inline-flex items-center gap-1 rounded-md border px-3 py-2 sm:px-2 sm:py-1 text-xs font-medium transition-colors disabled:opacity-40";
/** フォームの入力欄。スマホは 16px 未満だと iOS がフォーカス時に拡大するので text-base にする */
const INPUT =
  "border border-slate-300 rounded px-2 py-2 sm:py-1 text-base sm:text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500";

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
    classification: ClearanceLevel;
    entity: { canonicalName: string };
  } | null;
};

interface PlaceCandidateListProps {
  dossierId: string;
  candidates: Candidate[];
  editable: boolean;
  /** 確定時に選べる公開範囲 (自分のクリアランス以下)。空なら選ばせない (viewer) */
  classifications: ClearanceLevel[];
}

export function PlaceCandidateList({
  dossierId,
  candidates,
  editable,
  classifications,
}: PlaceCandidateListProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [googleMapsUrl, setGoogleMapsUrl] = useState("");
  const [note, setNote] = useState("");
  const [confidence, setConfidence] = useState("0");
  const [isPending, startTransition] = useTransition();
  // 確定パネルを開いている候補と、そこで選んだ公開範囲
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [promoteClassification, setPromoteClassification] = useState<ClearanceLevel>("internal");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // alert() はスマホで出ないことがあるので、失敗はカードの中に出す
  const [cardError, setCardError] = useState<{ id: string; message: string } | null>(null);

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
      setOpen(false);
    });
  }

  function remove(id: string) {
    startTransition(async () => {
      await removePlaceCandidateAction(id, dossierId);
      setDeletingId(null);
    });
  }

  function openPromote(c: Candidate) {
    if (c.place && c.place.status === "confirmed") return;
    setCardError(null);
    if (!c.place && (c.latitude == null || c.longitude == null)) {
      setCardError({ id: c.id, message: "確定にするには緯度・経度が必要です" });
      return;
    }
    // 既定は「一般」。自分のクリアランスで選べない値なら、選べる中で一番低いものにする
    const initial = c.place?.classification ?? "internal";
    setPromoteClassification(classifications.includes(initial) ? initial : classifications[0]);
    setDeletingId(null);
    setPromotingId(c.id);
  }

  function promote(c: Candidate) {
    startTransition(async () => {
      try {
        await promotePlaceCandidateAction(
          c.id,
          dossierId,
          classifications.length > 0 ? promoteClassification : undefined
        );
        setPromotingId(null);
      } catch (e) {
        setCardError({ id: c.id, message: `確定できませんでした: ${e instanceof Error ? e.message : String(e)}` });
      }
    });
  }

  function changeClassification(c: Candidate, level: ClearanceLevel) {
    if (!c.place || level === c.place.classification) return;
    const placeId = c.place.id;
    setCardError(null);
    startTransition(async () => {
      try {
        await updateCandidatePlaceClassificationAction(placeId, dossierId, level);
      } catch (e) {
        setCardError({ id: c.id, message: `公開範囲を変えられませんでした: ${e instanceof Error ? e.message : String(e)}` });
      }
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
                      {c.place ? (
                        <Link href={`/places/${c.place.id}`} className="truncate hover:text-indigo-600 hover:underline">
                          {c.place.entity.canonicalName}
                        </Link>
                      ) : (
                        c.name || "(無題)"
                      )}
                      {isConfirmed && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] bg-emerald-100 text-emerald-700 px-1 rounded">
                          <BadgeCheck className="h-2.5 w-2.5" /> 確定
                        </span>
                      )}
                    </p>
                    {isConfirmed && c.place && (
                      editable && classifications.includes(c.place.classification) ? (
                        <select
                          value={c.place.classification}
                          onChange={(e) => changeClassification(c, e.target.value as ClearanceLevel)}
                          disabled={isPending}
                          title="公開サイトに出すか"
                          className="mt-1 max-w-full border border-slate-200 rounded px-2 py-1.5 sm:px-1 sm:py-0.5 text-base sm:text-[11px] text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
                        >
                          {classifications.map((level) => (
                            <option key={level} value={level}>
                              {PLACE_CLASSIFICATION_LABELS[level]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <p className="text-[11px] text-slate-500">
                          {PLACE_CLASSIFICATION_LABELS[c.place.classification]}
                        </p>
                      )
                    )}
                    {c.address && <p className="text-[11px] text-slate-500 truncate">{c.address}</p>}
                    {c.note && <p className="text-[11px] text-slate-600 mt-1">{c.note}</p>}
                  </div>
                  <span className="shrink-0 text-[10px] text-slate-400">確度 {c.confidence}</span>
                </div>
                {(c.googleMapsUrl || editable) && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {editable && !isConfirmed && (
                      <button
                        type="button"
                        onClick={() => openPromote(c)}
                        disabled={isPending}
                        className={`${ACTION_BUTTON} border-emerald-300 text-emerald-700 hover:bg-emerald-50`}
                      >
                        <BadgeCheck className="h-3.5 w-3.5" /> 聖地として確定
                      </button>
                    )}
                    {c.googleMapsUrl && (
                      <a
                        href={c.googleMapsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`${ACTION_BUTTON} border-slate-200 text-indigo-600 hover:bg-indigo-50`}
                      >
                        <ExternalLink className="h-3.5 w-3.5" /> 地図
                      </a>
                    )}
                    {editable && (
                      <button
                        type="button"
                        onClick={() => {
                          setPromotingId(null);
                          setDeletingId((v) => (v === c.id ? null : c.id));
                        }}
                        disabled={isPending}
                        className={`${ACTION_BUTTON} ml-auto border-slate-200 text-rose-500 hover:bg-rose-50`}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> 削除
                      </button>
                    )}
                  </div>
                )}
                {cardError?.id === c.id && (
                  <p role="status" className="mt-2 rounded-md bg-amber-50 border border-amber-200 px-2 py-1.5 text-xs text-amber-800">
                    {cardError.message}
                  </p>
                )}
                {deletingId === c.id && (
                  <DeleteConfirm
                    className="mt-2"
                    message="この候補を削除しますか？"
                    onConfirm={() => remove(c.id)}
                    onCancel={() => setDeletingId(null)}
                    pending={isPending}
                  />
                )}
                {promotingId === c.id && (
                  <div className="mt-2 border-t border-slate-100 pt-2">
                    <p className="text-xs text-slate-600 mb-1.5">聖地として確定する (公開範囲を選ぶ)</p>
                    <div className="flex flex-wrap items-center gap-2">
                      {classifications.length > 0 && (
                        <select
                          value={promoteClassification}
                          onChange={(e) => setPromoteClassification(e.target.value as ClearanceLevel)}
                          className={`${INPUT} flex-1 min-w-[10rem] bg-white`}
                        >
                          {classifications.map((level) => (
                            <option key={level} value={level}>
                              {PLACE_CLASSIFICATION_LABELS[level]}
                            </option>
                          ))}
                        </select>
                      )}
                      <button
                        type="button"
                        onClick={() => promote(c)}
                        disabled={isPending}
                        className="bg-emerald-600 text-white px-4 py-2 sm:px-3 sm:py-1 rounded-md text-sm sm:text-xs font-medium hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                      >
                        確定
                      </button>
                      <button
                        type="button"
                        onClick={() => setPromotingId(null)}
                        disabled={isPending}
                        className="px-3 py-2 sm:px-2 sm:py-1 rounded-md text-sm sm:text-xs text-slate-500 hover:bg-slate-100 disabled:opacity-40"
                      >
                        やめる
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {editable && !open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 rounded-md border border-indigo-200 px-3 py-2 sm:px-2 sm:py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50"
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
              aria-label="閉じる"
              className="-mr-1 inline-flex h-9 w-9 sm:h-7 sm:w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              <X className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
            </button>
          </div>

          <PlaceLookup
            size="sm"
            googleMapsUrl={googleMapsUrl}
            onGoogleMapsUrlChange={setGoogleMapsUrl}
            hasCoordinates={latitude !== ""}
            onResolved={(place) => {
              if (place.name && !name) setName(place.name);
              if (place.address) setAddress(place.address);
              if (place.lat != null) setLatitude(String(place.lat));
              if (place.lng != null) setLongitude(String(place.lng));
              if (place.googleMapsUrl) setGoogleMapsUrl(place.googleMapsUrl);
            }}
          />

          <div className="border-t border-slate-100 pt-2 mt-2">
            <p className="text-[10px] text-slate-400 mb-1.5">詳細・微修正</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="店名/場所名"
                className={INPUT}
              />
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="住所"
                className={INPUT}
              />
              <input
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
                placeholder="緯度"
                type="number"
                step="0.000001"
                className={INPUT}
              />
              <input
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
                placeholder="経度"
                type="number"
                step="0.000001"
                className={INPUT}
              />
              <input
                value={confidence}
                onChange={(e) => setConfidence(e.target.value)}
                placeholder="確度 (0-100)"
                type="number"
                min="0"
                max="100"
                className={INPUT}
              />
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="メモ"
                className={INPUT}
              />
            </div>
          </div>

          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={add}
              disabled={isPending}
              className="bg-indigo-600 text-white px-4 py-2 sm:px-3 sm:py-1 rounded-md text-sm sm:text-xs font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
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
