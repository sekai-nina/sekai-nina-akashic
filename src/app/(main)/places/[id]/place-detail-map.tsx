"use client";

import { DynamicMap } from "@/components/dynamic-map";

interface PlaceDetailMapProps {
  lat: number;
  lng: number;
  label: string;
}

export function PlaceDetailMap({ lat, lng, label }: PlaceDetailMapProps) {
  return (
    <DynamicMap
      markers={[{ id: "current", lat, lng, label }]}
      center={[lat, lng]}
      zoom={15}
      className="h-[300px] w-full rounded-lg"
    />
  );
}
