import { listPlaces } from "@/lib/domain/places";

export interface AreaHint {
  area: string;
  count: number;
  lat: number;
  lng: number;
}

/**
 * 既存のエリア名と、そのエリアに属する場所の重心。
 * フォームの入力候補 (datalist) と、新規登録時の「近くの場所と同じエリア」の提案に使う。
 */
export async function listAreaHints(clearance: string): Promise<AreaHint[]> {
  const places = await listPlaces(clearance);
  const acc = new Map<string, { count: number; lat: number; lng: number }>();
  for (const p of places) {
    if (!p.area) continue;
    const a = acc.get(p.area) ?? { count: 0, lat: 0, lng: 0 };
    a.count += 1;
    a.lat += p.latitude;
    a.lng += p.longitude;
    acc.set(p.area, a);
  }
  return [...acc.entries()]
    .map(([area, a]) => ({ area, count: a.count, lat: a.lat / a.count, lng: a.lng / a.count }))
    .sort((x, y) => y.count - x.count || x.area.localeCompare(y.area, "ja"));
}

const R = 6371;
export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLng = (lng2 - lng1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 座標に一番近いエリア (重心から maxKm 以内)。無ければ null */
export function nearestArea(hints: AreaHint[], lat: number, lng: number, maxKm = 30): string | null {
  let best: { area: string; d: number } | null = null;
  for (const h of hints) {
    const d = distanceKm(lat, lng, h.lat, h.lng);
    if (d <= maxKm && (!best || d < best.d)) best = { area: h.area, d };
  }
  return best?.area ?? null;
}
