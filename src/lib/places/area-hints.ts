// クライアント (新規登録フォーム) からも読むので、サーバー専用のモジュールは import しない。
// 一覧を引く listAreaHints は `@/lib/domain/places` にある

export interface AreaHint {
  area: string;
  count: number;
  lat: number;
  lng: number;
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
