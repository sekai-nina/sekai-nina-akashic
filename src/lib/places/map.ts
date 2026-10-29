import type { ClearanceLevel, PlaceKind } from "@prisma/client";

/**
 * 聖地マップ (/places) に渡すデータ。公開サイト (sekai-nina-site の /map) と同じく場所中心で、
 * 各場所に訪問した記事を持たせる。サイトと違い、Akashic では登録日 (新着) と未設定の項目も見せる。
 */

/** 種類が未設定の聖地はピンを灰色の汎用アイコンにする (サイトのように推定はしない。人が付ける目印にする) */
export type MapKind = PlaceKind | "unset";

/** 登録からこの日数以内の聖地に NEW を付ける */
export const NEW_PLACE_DAYS = 14;

/** エリア未設定の聖地のまとめ先 (サイトと同じ) */
export const OTHER_AREA = "その他";

export interface MapVisit {
  shortId: string;
  title: string;
  /** YYYY-MM-DD (JST)。日付の無い記事は "" */
  date: string;
  dateDisplay: string;
  /** 記事内の訪問順 (1 始まり) と地点数 */
  order: number;
  total: number;
}

export interface MapPlace {
  id: string;
  name: string;
  description: string;
  lat: number;
  lng: number;
  address: string;
  gmaps: string;
  kind: MapKind;
  /** 未設定は OTHER_AREA */
  area: string;
  areaUnset: boolean;
  classification: ClearanceLevel;
  assetCount: number;
  /** ISO 文字列 */
  createdAt: string;
  isNew: boolean;
  /** 新しい順 */
  visits: MapVisit[];
}

export interface MapArticle {
  shortId: string;
  title: string;
  date: string;
  dateDisplay: string;
  /** place id を訪問順に */
  places: string[];
}

export interface PlaceMapData {
  /** 登録が新しい順 */
  places: MapPlace[];
  articles: MapArticle[];
  /** 件数の多い順。「その他」は最後 */
  areas: string[];
}

export interface PlaceRow {
  id: string;
  latitude: number;
  longitude: number;
  googleMapsUrl: string | null;
  address: string | null;
  kind: PlaceKind | null;
  area: string | null;
  classification: ClearanceLevel;
  // unstable_cache を通ると Date は文字列になる
  createdAt: Date | string;
  entity: { canonicalName: string; description: string; _count: { assets: number } };
  articles: {
    sortOrder: number;
    article: { shortId: string; title: string; date: Date | string | null; dateDisplay: string | null };
  }[];
}

const jstDate = (d: Date | string | null) =>
  d ? new Date(new Date(d).getTime() + 9 * 3600_000).toISOString().slice(0, 10) : "";

export function buildPlaceMapData(rows: PlaceRow[], now = new Date()): PlaceMapData {
  // 記事ごとの地点 (訪問順)。ルート表示と「この記事の N か所」に使う
  const byArticle = new Map<string, MapArticle & { orders: number[] }>();
  for (const p of rows) {
    for (const ap of p.articles) {
      const a = ap.article;
      let e = byArticle.get(a.shortId);
      if (!e) {
        e = { shortId: a.shortId, title: a.title, date: jstDate(a.date), dateDisplay: a.dateDisplay ?? "", places: [], orders: [] };
        byArticle.set(a.shortId, e);
      }
      e.places.push(p.id);
      e.orders.push(ap.sortOrder);
    }
  }
  const articles: MapArticle[] = [...byArticle.values()].map(({ orders, ...a }) => ({
    ...a,
    places: a.places.map((id, i) => [id, orders[i]] as const).sort((x, y) => x[1] - y[1]).map(([id]) => id),
  }));
  const articleById = new Map(articles.map((a) => [a.shortId, a]));

  const newSince = now.getTime() - NEW_PLACE_DAYS * 86400_000;
  const places: MapPlace[] = rows.map((p) => {
    const createdAt = new Date(p.createdAt);
    const visits = p.articles
      .map(({ article }): MapVisit => {
        const a = articleById.get(article.shortId)!;
        return {
          shortId: a.shortId,
          title: a.title,
          date: a.date,
          dateDisplay: a.dateDisplay,
          order: a.places.indexOf(p.id) + 1,
          total: a.places.length,
        };
      })
      .sort((x, y) => y.date.localeCompare(x.date));
    return {
      id: p.id,
      name: p.entity.canonicalName,
      description: p.entity.description,
      lat: p.latitude,
      lng: p.longitude,
      address: p.address ?? "",
      gmaps: p.googleMapsUrl || `https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude}`,
      kind: p.kind ?? "unset",
      area: p.area || OTHER_AREA,
      areaUnset: !p.area,
      classification: p.classification,
      assetCount: p.entity._count.assets,
      createdAt: createdAt.toISOString(),
      isNew: createdAt.getTime() >= newSince,
      visits,
    };
  });

  const areaCount = new Map<string, number>();
  for (const p of places) areaCount.set(p.area, (areaCount.get(p.area) ?? 0) + 1);
  const areas = [...areaCount.entries()]
    .sort((a, b) => Number(a[0] === OTHER_AREA) - Number(b[0] === OTHER_AREA) || b[1] - a[1] || a[0].localeCompare(b[0], "ja"))
    .map(([a]) => a);

  return { places, articles, areas };
}

/** 種類の線画アイコン (lucide 相当の path)。ピン・チップ・リストで共用。サイトの map.astro と同じ形 */
export const MAP_KIND_ICONS: Record<MapKind, string> = {
  food: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
  leisure: '<circle cx="12" cy="12" r="2"/><path d="M12 2v4"/><path d="m6.8 15-3.5 2"/><path d="m20.7 7-3.5 2"/><path d="M6.8 9 3.3 7"/><path d="m20.7 17-3.5-2"/><path d="m9 22 3-8 3 8"/><path d="M8 22h8"/><path d="M18 18.7a9 9 0 1 0-12 0"/>',
  scenery: '<path d="M3 5h18"/><path d="M4.5 5c2-1.2 13-1.2 15 0"/><path d="M6.5 5v16M17.5 5v16"/><path d="M5 10.5h14"/>',
  venue: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>',
  shop: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  unset: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
};

/** ピンの塗り色 (サイトのブランド色に寄せる) */
export const MAP_KIND_COLORS: Record<MapKind, string> = {
  food: "#e07a5f",
  leisure: "#8e6bb8",
  scenery: "#3d8a80",
  venue: "#3b6ea8",
  shop: "#b0841a",
  unset: "#94a3b8",
};
