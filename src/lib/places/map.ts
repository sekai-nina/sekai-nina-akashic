import type { ClearanceLevel, PlaceKind } from "@prisma/client";
import { jstDayString } from "@/lib/utils";

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
  draft: boolean;
  /** この訪問の確度 (#333)。likely は「ほぼ確定」 */
  certainty: "confirmed" | "likely";
  certaintyNote: string;
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
  /** 公開サイトの聖地マップ・記事に出るか (public / internal)。限定・極秘は出ない */
  onSite: boolean;
  assetCount: number;
  /** ISO 文字列 */
  createdAt: string;
  isNew: boolean;
  /** 新しい順 */
  visits: MapVisit[];
  /** 訪問があり、そのすべてがほぼ確定 (ピンを見分ける。#333) */
  likelyOnly: boolean;
}

export interface MapArticle {
  shortId: string;
  title: string;
  date: string;
  dateDisplay: string;
  draft: boolean;
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
    certainty: "confirmed" | "likely";
    certaintyNote: string;
    article: { shortId: string; title: string; date: Date | string | null; dateDisplay: string | null; draft: boolean };
  }[];
}

const jstDate = (d: Date | string | null) => (d ? jstDayString(new Date(d)) : "");

/** googleMapsUrl は人や API が書く自由文字列なので、http(s) 以外は座標の検索 URL に置き換える */
const safeMapsUrl = (url: string | null, lat: number, lng: number) =>
  url && /^https?:\/\//i.test(url) ? url : `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

export function buildPlaceMapData(rows: PlaceRow[], now = new Date()): PlaceMapData {
  // 記事ごとの地点 (訪問順)。ルート表示と「この記事の N か所」に使う
  const byArticle = new Map<string, MapArticle & { orders: number[] }>();
  for (const p of rows) {
    for (const ap of p.articles) {
      const a = ap.article;
      let e = byArticle.get(a.shortId);
      if (!e) {
        e = { shortId: a.shortId, title: a.title, date: jstDate(a.date), dateDisplay: a.dateDisplay ?? "", draft: a.draft, places: [], orders: [] };
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
      .map(({ article, certainty, certaintyNote }): MapVisit => {
        const a = articleById.get(article.shortId)!;
        return {
          shortId: a.shortId,
          title: a.title,
          date: a.date,
          dateDisplay: a.dateDisplay,
          order: a.places.indexOf(p.id) + 1,
          total: a.places.length,
          draft: a.draft,
          certainty,
          certaintyNote: certainty === "likely" ? certaintyNote : "",
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
      gmaps: safeMapsUrl(p.googleMapsUrl, p.latitude, p.longitude),
      kind: p.kind ?? "unset",
      area: p.area || OTHER_AREA,
      areaUnset: !p.area,
      classification: p.classification,
      // src/lib/articles/frontmatter.ts の isPublishablePlace と同じ判定 (あちらは Prisma の enum を読むのでクライアントに持ち込まない)
      onSite: p.classification === "public" || p.classification === "internal",
      assetCount: p.entity._count.assets,
      createdAt: createdAt.toISOString(),
      isNew: createdAt.getTime() >= newSince,
      visits,
      likelyOnly: visits.length > 0 && visits.every((v) => v.certainty === "likely"),
    };
  });

  const areaCount = new Map<string, number>();
  for (const p of places) areaCount.set(p.area, (areaCount.get(p.area) ?? 0) + 1);
  const areas = [...areaCount.entries()]
    .sort((a, b) => Number(a[0] === OTHER_AREA) - Number(b[0] === OTHER_AREA) || b[1] - a[1] || a[0].localeCompare(b[0], "ja"))
    .map(([a]) => a);

  return { places, articles, areas };
}

/** 絞り込みチップの並び */
export const MAP_KIND_ORDER: MapKind[] = ["food", "leisure", "scenery", "venue", "shop", "unset"];

/** 種類の線画アイコン (lucide 相当の path)。ピン・チップ・リストで共用。サイトの map.astro と同じ形 */
export const MAP_KIND_ICONS: Record<MapKind, string> = {
  food: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
  leisure: '<circle cx="12" cy="12" r="2"/><path d="M12 2v4"/><path d="m6.8 15-3.5 2"/><path d="m20.7 7-3.5 2"/><path d="M6.8 9 3.3 7"/><path d="m20.7 17-3.5-2"/><path d="m9 22 3-8 3 8"/><path d="M8 22h8"/><path d="M18 18.7a9 9 0 1 0-12 0"/>',
  scenery: '<path d="M3 5h18"/><path d="M4.5 5c2-1.2 13-1.2 15 0"/><path d="M6.5 5v16M17.5 5v16"/><path d="M5 10.5h14"/>',
  venue: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>',
  shop: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  unset: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
};

/** サイトに出さない (限定・極秘) 聖地のピンに付ける鍵 */
export const MAP_LOCK_ICON = '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>';

/** ピンの塗り色 (サイトのブランド色に寄せる) */
export const MAP_KIND_COLORS: Record<MapKind, string> = {
  food: "#e07a5f",
  leisure: "#8e6bb8",
  scenery: "#3d8a80",
  venue: "#3b6ea8",
  shop: "#b0841a",
  unset: "#94a3b8",
};
