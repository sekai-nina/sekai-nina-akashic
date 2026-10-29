import { auth } from "@/lib/auth";
import { getCachedPlaces } from "@/lib/cache";
import Link from "next/link";
import { MapPin, Plus } from "lucide-react";
import { notFound } from "next/navigation";
import type { ClearanceLevel } from "@prisma/client";
import { PlacesMap } from "./places-map";
import { buildPlaceMapData, NEW_PLACE_DAYS } from "@/lib/places/map";

export default async function PlacesPage() {
  const session = await auth();
  if (!session?.user) notFound();

  const places = await getCachedPlaces(session.user.clearance as ClearanceLevel);
  // NEW の判定はキャッシュの外で行う (キャッシュに入れると最大 60 秒ぶん古い「今」で切られる)
  const data = buildPlaceMapData(places);
  const newCount = data.places.filter((p) => p.isNew).length;

  // 地図を画面いっぱいに広げるため、レイアウトの余白を打ち消す (スマホは上の 48px がヘッダー)
  return (
    <div className="-mx-4 -mt-2 -mb-24 md:-m-6 h-[calc(100dvh-3rem)] md:h-dvh flex flex-col">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-200 bg-white">
        <h1 className="text-base font-bold text-slate-900 flex items-center gap-1.5">
          <MapPin className="h-5 w-5 text-green-600" />
          聖地マップ
        </h1>
        <p className="text-slate-500 text-xs">
          全 {data.places.length} 件
          {newCount > 0 && (
            <span className="ml-2 font-semibold text-rose-600">
              新着 {newCount} 件（{NEW_PLACE_DAYS}日以内）
            </span>
          )}
        </p>
        <Link
          href="/places/new"
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors"
        >
          <Plus className="h-4 w-4" />
          新規登録
        </Link>
      </div>
      <PlacesMap data={data} />
    </div>
  );
}
