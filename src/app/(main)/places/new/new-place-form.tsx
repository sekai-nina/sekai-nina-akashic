"use client";

import { useEffect, useState } from "react";
import { createPlaceAction } from "@/lib/actions";
import { SubmitButton } from "@/components/submit-button";
import { PlaceLookup } from "@/components/place-lookup";
import { PLACE_KIND_LABELS } from "@/lib/utils";
import type { PlaceKind } from "@prisma/client";
import { nearestArea, type AreaHint } from "@/lib/places/area-hints";

export function NewPlaceForm({ areaHints }: { areaHints: AreaHint[] }) {
  const [name, setName] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [googleMapsUrl, setGoogleMapsUrl] = useState("");
  const [address, setAddress] = useState("");
  const [area, setArea] = useState("");
  const [areaTouched, setAreaTouched] = useState(false);

  // 座標が決まったら、近く (重心から 30km 以内) の既存エリアを提案する。手で触ったら上書きしない
  useEffect(() => {
    if (areaTouched) return;
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    setArea(nearestArea(areaHints, lat, lng) ?? "");
  }, [latitude, longitude, areaTouched, areaHints]);

  const fieldClass =
    "w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500";

  return (
    <form
      action={createPlaceAction}
      className="bg-white border border-slate-200 rounded-lg p-6 space-y-4"
    >
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">
          Google Maps から取り込む
        </label>
        <div className="space-y-2">
          <PlaceLookup
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
        </div>
        <p className="mt-1 text-xs text-slate-400">
          店名で検索するか、Google Maps の共有 URL を貼ると下の項目が埋まります
        </p>
      </div>

      <hr className="border-slate-100" />

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">
          名前 <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          name="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例: サニーヒルズ南青山"
          className={fieldClass}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            緯度 <span className="text-red-500">*</span>
          </label>
          <input
            type="number"
            name="latitude"
            step="any"
            required
            value={latitude}
            onChange={(e) => setLatitude(e.target.value)}
            placeholder="35.6660"
            className={fieldClass}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            経度 <span className="text-red-500">*</span>
          </label>
          <input
            type="number"
            name="longitude"
            step="any"
            required
            value={longitude}
            onChange={(e) => setLongitude(e.target.value)}
            placeholder="139.7167"
            className={fieldClass}
          />
        </div>
      </div>

      <input type="hidden" name="googleMapsUrl" value={googleMapsUrl} />

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">住所</label>
        <input
          type="text"
          name="address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="例: 東京都港区南青山3-10-20"
          className={fieldClass}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">エリア</label>
        <input
          type="text"
          name="area"
          list="place-area-hints"
          value={area}
          onChange={(e) => {
            setAreaTouched(true);
            setArea(e.target.value);
          }}
          placeholder="例: 東京 / 横浜・川崎 / 名古屋"
          className={fieldClass}
        />
        <datalist id="place-area-hints">
          {areaHints.map((h) => (
            <option key={h.area} value={h.area}>{`${h.area}（${h.count}件）`}</option>
          ))}
        </datalist>
        <p className="text-xs text-slate-400 mt-1">
          公開サイトの聖地マップの絞り込みと、遠景でのまとまりに使う。座標を入れると近くの場所と同じエリアが入る
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">種類</label>
        <select name="kind" defaultValue="" className={`${fieldClass} bg-white`}>
          <option value="">未設定（サイト側で名前から推定）</option>
          {(Object.keys(PLACE_KIND_LABELS) as PlaceKind[]).map((k) => (
            <option key={k} value={k}>
              {PLACE_KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <p className="text-xs text-slate-400 mt-1">公開サイトの聖地マップでピンのアイコンと絞り込みに使う</p>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">説明</label>
        <textarea
          name="description"
          rows={3}
          placeholder="この聖地についての説明..."
          className={fieldClass}
        />
      </div>

      <div className="pt-2">
        <SubmitButton
          className="w-full px-4 py-2.5 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg justify-center"
          pendingText="登録中..."
        >
          登録する
        </SubmitButton>
      </div>
    </form>
  );
}
