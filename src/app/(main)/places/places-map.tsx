"use client";

import dynamic from "next/dynamic";
import type { PlaceMapData } from "@/lib/places/map";

// Leaflet は window を触るのでサーバーでは描かない
const PlaceMap = dynamic(() => import("./place-map").then((m) => m.PlaceMap), {
  ssr: false,
  loading: () => (
    <div className="flex-1 bg-slate-100 animate-pulse flex items-center justify-center text-slate-400 text-sm">
      地図を読み込み中...
    </div>
  ),
});

export function PlacesMap({ data }: { data: PlaceMapData }) {
  return <PlaceMap data={data} />;
}
