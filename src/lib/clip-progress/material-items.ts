import type { AssetKind, ClearanceLevel, ItemRule } from "@prisma/client";
import { jstDayString } from "@/lib/utils";

export const MATERIAL_SOURCE_KEYS = [
  "blog", "talk", "hinaai", "ninarimashou", "hinachan", "official_ch",
  "magazine", "instagram", "tiktok", "radio", "showroom", "x_official",
] as const;
export type MaterialSourceKey = (typeof MATERIAL_SOURCE_KEYS)[number];

export function isMaterialSourceKey(key: string): key is MaterialSourceKey {
  return (MATERIAL_SOURCE_KEYS as readonly string[]).includes(key);
}

export interface MaterialItem {
  itemKey: string;
  itemDate: string | null;
  itemTitle: string | null;
  articleShortId?: string;
  /** ラジオの行に明記された出典 URL。記事へのリンクとは区別する。 */
  sourceUrls?: string[];
  program?: string;
}

export interface MaterialSource {
  key: string;
  itemRule: ItemRule;
  publisherPattern: string | null;
  titlePattern: string | null;
}

/** SQL LIKE と同じ大文字小文字区別・複数パターン OR。 */
export function matchesLikeOr(value: string | null | undefined, pattern: string | null): boolean {
  const parts = (pattern ?? "").split("|").map((s) => s.trim()).filter(Boolean);
  return parts.length === 0 || parts.some((p) => new RegExp(`^${p
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, "[\\s\\S]*").replace(/_/g, "[\\s\\S]")}$`).test(value ?? ""));
}

export interface MaterialAsset {
  id: string;
  kind: AssetKind;
  title: string;
  canonicalDate: Date | null;
  classification: ClearanceLevel;
  sourceRecords: { url: string | null; title: string | null; publisher: string | null }[];
}

/**
 * URL 系ソースの素材は本文アセット (kind=text) ごとに数える (#429)。キーは `asset:<本文アセット id>`。
 * 雑誌の 1 冊に Amazon と X の告知の 2 URL が付いていても 1 件にし、ページ画像・ブログ画像は
 * 同じ URL の本文アセットに含める。本文アセットの無い URL (インスタ・動画) は URL をそのままキーにする。
 */
export const TEXT_ASSET_KEY_PREFIX = "asset:";
export const textAssetKey = (assetId: string) => `${TEXT_ASSET_KEY_PREFIX}${assetId}`;
export function textAssetIdOfKey(key: string): string | null {
  return key.startsWith(TEXT_ASSET_KEY_PREFIX) ? key.slice(TEXT_ASSET_KEY_PREFIX.length) || null : null;
}

/** URL ごとの所属。同じ URL に本文アセットが複数あれば (二重取り込み) 最も古いものに寄せる */
export interface UrlMaterial { key: string; title: string | null }

/** URL ごとに導出した素材を、所属する本文アセットごとに 1 件へまとめる。日付は最も早いもの */
export function mergeUrlItems(items: MaterialItem[], byUrl: Map<string, UrlMaterial>): MaterialItem[] {
  const merged = new Map<string, MaterialItem>();
  for (const item of items) {
    const group = byUrl.get(item.itemKey);
    const key = group?.key ?? item.itemKey;
    const prev = merged.get(key);
    const itemDate = [prev?.itemDate, item.itemDate].filter((d): d is string => !!d).sort()[0] ?? null;
    merged.set(key, { ...item, itemKey: key, itemDate, itemTitle: group?.title ?? prev?.itemTitle ?? item.itemTitle });
  }
  return [...merged.values()];
}

/** 一覧・アセット詳細・保存時で同じ JST の素材キーを使う。URL 系は本文アセットに寄せる前の URL を返す */
export function itemKeysForAsset(source: MaterialSource, asset: MaterialAsset): string[] {
  const records = asset.sourceRecords.filter((sr) =>
    matchesLikeOr(sr.publisher, source.publisherPattern) && matchesLikeOr(sr.title, source.titlePattern));
  if (!records.length || source.itemRule === "manual") return [];
  if (source.itemRule === "talk_date") return asset.canonicalDate ? [jstDayString(asset.canonicalDate)] : [];
  return [...new Set(records.flatMap((sr) => sr.url ? [sr.url] : []))];
}

const cellsOf = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "")
  .split(/(?<!\\)\|/).map((s) => s.trim().replace(/\\\|/g, "|"));

/** 実記事の「#・放送日・番組名・出演メンバー・関連リンク」の表だけを読む。 */
export function deriveRadioItems(articles: { shortId: string; title: string; body: string }[]): MaterialItem[] {
  const items = new Map<string, MaterialItem>();
  for (const article of articles) {
    if (!/^(?:【\d+年目】)?ラジオ出演一覧$/.test(article.title)) continue;
    const lines = article.body.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      if (!/^\|(?:\s*:?-+:?\s*\|)+\s*$/.test(lines[i].trim())) continue;
      const columns = cellsOf(lines[i - 1]);
      const number = columns.indexOf("#"), date = columns.indexOf("放送日"), program = columns.indexOf("番組名");
      if (number < 0 || date < 0 || program < 0) continue;
      for (i++; i < lines.length && lines[i].trimStart().startsWith("|"); i++) {
        const cells = cellsOf(lines[i]);
        const n = cells[number];
        const m = cells[date]?.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
        if (!/^\d+[a-z]?$/.test(n ?? "") || !m || !cells[program]) continue;
        const day = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
        const parsed = new Date(`${day}T00:00:00Z`);
        if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) continue;
        const itemKey = `${article.shortId}:${n}`;
        items.set(itemKey, {
          itemKey, itemDate: day, itemTitle: cells[program], program: cells[program], articleShortId: article.shortId,
          sourceUrls: [...new Set([...cells.join(" ").matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)].map((m) => m[1]))],
        });
      }
    }
  }
  return [...items.values()].sort((a, b) => (a.itemDate ?? "").localeCompare(b.itemDate ?? "") || a.itemKey.localeCompare(b.itemKey));
}

/** 出典 URL の一致を優先し、録音は JST 放送日と番組名の両方が一致する場合に対応させる。 */
export function radioItemMatchesAsset(item: MaterialItem, asset: MaterialAsset): boolean {
  if (asset.sourceRecords.some((sr) => sr.url && item.sourceUrls?.includes(sr.url))) return true;
  if (!asset.canonicalDate || jstDayString(asset.canonicalDate) !== item.itemDate || !item.program) return false;
  const normalize = (s: string) => s.normalize("NFKC").replace(/[\s「」『』!！・]/g, "");
  const program = normalize(item.program).replace(/[（(]第\d+回.*$/, "");
  return program.length > 0 && [asset.title, ...asset.sourceRecords.map((sr) => sr.title ?? "")]
    .some((title) => normalize(title).includes(program));
}

/** 本人著 ∪ 言及あり ∪ 手動対象。済は対象であることも表す。 */
export function isRelevantMaterial(itemKey: string, automatic: Set<string>, status?: { included: boolean; done: boolean }): boolean {
  return automatic.has(itemKey) || !!status?.included || !!status?.done;
}
