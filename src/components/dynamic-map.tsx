"use client";

import dynamic from "next/dynamic";
import type { MapMarker } from "./leaflet-map";

const LeafletMap = dynamic(() => import("./leaflet-map").then((m) => m.LeafletMap), {
  ssr: false,
  loading: () => (
    <div className="h-[400px] w-full rounded-lg bg-gray-100 animate-pulse flex items-center justify-center text-gray-400">
      地図を読み込み中...
    </div>
  ),
});

interface DynamicMapProps {
  markers: MapMarker[];
  center?: [number, number];
  zoom?: number;
  className?: string;
  onMarkerClick?: (id: string) => void;
}

export function DynamicMap(props: DynamicMapProps) {
  return <LeafletMap {...props} />;
}
