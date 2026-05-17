"use client";

import { useRouter } from "next/navigation";
import { DynamicMap } from "@/components/dynamic-map";
import type { MapMarker } from "@/components/leaflet-map";

interface PlacesMapProps {
  markers: MapMarker[];
}

export function PlacesMap({ markers }: PlacesMapProps) {
  const router = useRouter();

  return (
    <DynamicMap
      markers={markers}
      onMarkerClick={(id) => router.push(`/places/${id}`)}
    />
  );
}
