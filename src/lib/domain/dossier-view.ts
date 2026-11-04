import { isTalk } from "@/lib/article-workflow/render";
import { stripImagePlaceholders } from "@/lib/utils";

/**
 * 企画の詳細ページに出す、アセットから導いた表示 (DB に触らない純粋関数)。
 * 候補やアイテムの行は増やさず、開くたびに今のアセットから組み立てる
 */

/** 企画の画面に本文として出すテキストの種類 (表示の順) */
export const DOSSIER_BODY_TEXT_TYPES = ["message_body", "body", "transcript"] as const;

export interface AssetPlaceLink {
  id: string;
  latitude: number;
  longitude: number;
  address: string | null;
  googleMapsUrl: string | null;
}

interface SuggestionItem {
  asset: {
    id: string;
    title: string;
    entities: { entity: { canonicalName: string; place: AssetPlaceLink | null } }[];
  } | null;
}

interface ExistingCandidate {
  placeId: string | null;
  name: string;
}

export interface AssetPlaceSuggestion extends AssetPlaceLink {
  name: string;
  /** この聖地が結びついている企画内のアセット (同じアセットを抜粋ごとに入れても 1 つ) */
  assets: { id: string; title: string }[];
}

/**
 * 企画に入っているアセットに結びついた聖地のうち、まだ場所候補に無いもの (アイテムの並び順)。
 * 聖地を指していない手入力の候補も、同じ名前なら同じ場所として出さない
 */
export function deriveAssetPlaceSuggestions(
  items: SuggestionItem[],
  candidates: ExistingCandidate[]
): AssetPlaceSuggestion[] {
  const placeIds = new Set(candidates.flatMap((c) => (c.placeId ? [c.placeId] : [])));
  const inlineNames = new Set(candidates.flatMap((c) => (c.placeId ? [] : [c.name.trim()])));
  const byPlace = new Map<string, AssetPlaceSuggestion>();
  for (const { asset } of items) {
    for (const { entity } of asset?.entities ?? []) {
      const { place, canonicalName } = entity;
      if (!asset || !place || placeIds.has(place.id) || inlineNames.has(canonicalName.trim())) continue;
      let row = byPlace.get(place.id);
      if (!row) byPlace.set(place.id, (row = { ...place, name: canonicalName, assets: [] }));
      if (!row.assets.some((a) => a.id === asset.id)) row.assets.push({ id: asset.id, title: asset.title });
    }
  }
  return [...byPlace.values()];
}

export interface DossierItemBody {
  text: string;
  /** トークは全文を出す。ブログなどの長い本文は小さい窓の中でスクロールする */
  full: boolean;
}

interface TalkAsset {
  id: string;
  kind: string;
  title: string;
  sourceRecords: { sourceKind: string; title: string; url: string | null }[];
}

interface BodyAsset extends TalkAsset {
  texts: { textType: string; content: string }[];
}

/** トークのアセットか。先頭の出典で見る (記事の素材の振り分けと同じ判定) */
export function isTalkAsset(asset: TalkAsset): boolean {
  const src = asset.sourceRecords[0] ?? null;
  return isTalk({
    id: asset.id,
    kind: asset.kind as never,
    title: asset.title,
    canonicalDate: null,
    sortAt: null,
    source: src ? { kind: src.sourceKind, title: src.title, url: src.url, publishedAt: null } : null,
    excerpts: [],
  });
}

/** アイテムに出す本文。本文の無いアセットは null */
export function dossierItemBody(asset: BodyAsset): DossierItemBody | null {
  const parts = DOSSIER_BODY_TEXT_TYPES.flatMap((type) =>
    asset.texts.filter((t) => t.textType === type).map((t) => stripImagePlaceholders(t.content).trim())
  ).filter(Boolean);
  if (parts.length === 0) return null;
  return { text: [...new Set(parts)].join("\n\n"), full: isTalkAsset(asset) };
}
