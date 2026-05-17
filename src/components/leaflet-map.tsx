"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Fix default marker icons in webpack/next.js
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  label: string;
  popupHtml?: string;
}

interface LeafletMapProps {
  markers: MapMarker[];
  center?: [number, number];
  zoom?: number;
  className?: string;
  onMarkerClick?: (id: string) => void;
}

export function LeafletMap({
  markers,
  center,
  zoom = 6,
  className = "h-[400px] w-full rounded-lg",
  onMarkerClick,
}: LeafletMapProps) {
  const mapRef = useRef<L.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const defaultCenter: [number, number] = center ?? [36.5, 138.0];
    const map = L.map(containerRef.current).setView(defaultCenter, zoom);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Clear existing markers
    map.eachLayer((layer) => {
      if (layer instanceof L.Marker) map.removeLayer(layer);
    });

    // Add markers
    const markerGroup: L.Marker[] = [];
    for (const m of markers) {
      const marker = L.marker([m.lat, m.lng]).addTo(map);
      if (m.popupHtml) {
        marker.bindPopup(m.popupHtml);
      } else {
        marker.bindPopup(m.label);
      }
      if (onMarkerClick) {
        marker.on("click", () => onMarkerClick(m.id));
      }
      markerGroup.push(marker);
    }

    // Fit bounds if markers exist and no explicit center
    if (markerGroup.length > 0 && !center) {
      const group = L.featureGroup(markerGroup);
      map.fitBounds(group.getBounds().pad(0.1));
    }
  }, [markers, center, onMarkerClick]);

  return <div ref={containerRef} className={className} />;
}
