import { unstable_cache } from "next/cache";
import { Prisma, type DataSource } from "@prisma/client";
import { withClearance, withSession, type TransactionClient } from "@/lib/db";
import { assertClearance, isAboveClearance } from "@/lib/classification";
import { deriveItems, getDerivedItems, sourcePatternConds, TALK_DAY_SQL, talkDaysSql, toDateOnlyString, type DerivedItem } from "./coverage";
import { getSourceAuthorKeys, getSourceMentionKeys } from "./coverage-items";
import { logAudit } from "./audit";
import {
  MATERIAL_SOURCE_KEYS, deriveRadioItems, isMaterialSourceKey, isRelevantMaterial, itemKeysForAsset, mergeUrlItems,
  radioItemMatchesAsset, textAssetIdOfKey, textAssetKey, type MaterialAsset, type MaterialItem, type UrlMaterial,
} from "@/lib/clip-progress/material-items";

interface Actor { id: string; clearance: string }
export class MaterialProgressInputError extends Error {}
export class MaterialProgressPermissionError extends Error {}

/** 見えない同一キーへの upsert は、既存行の存在や機密レベルを返さずに拒否する。 */
function isPermissionConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2004", "P2025"].includes(error.code)) return true;
  return error instanceof Error && /row-level security/i.test(error.message);
}
export interface MaterialProgressRow extends MaterialItem {
  done: boolean;
  included: boolean;
  automatic: boolean;
  clipCount: number;
  assetId: string | null;
}
/** ブログの絞り込み。本人のブログと他メンバーのブログ (言及あり) は情報量がかなり違うので分けて見る */
export type MaterialAuthorFilter = "all" | "self" | "others";
export const MATERIAL_AUTHOR_FILTERS: readonly MaterialAuthorFilter[] = ["all", "self", "others"];

export interface MaterialProgressResult {
  sourceKey: string;
  /** 絞り込み後の件数 */
  total: number;
  done: number;
  /** 本人著で分けられるソース (ブログ) だけ。絞り込み前の内訳 */
  authorTotals: { all: number; self: number; others: number } | null;
  page: number;
  pageSize: number;
  items: MaterialProgressRow[];
}

async function radioItems(tx: TransactionClient): Promise<MaterialItem[]> {
  const articles = await tx.article.findMany({
    where: { title: { endsWith: "ラジオ出演一覧" } },
    select: { shortId: true, title: true, body: true },
  });
  return deriveRadioItems(articles);
}

async function getSource(key: string, clearance: string) {
  if (!isMaterialSourceKey(key)) throw new MaterialProgressInputError("データソースの指定が不正です");
  const source = await withClearance(clearance, (tx) => tx.dataSource.findUnique({ where: { key } }));
  if (!source) throw new MaterialProgressInputError("データソースが見つかりません");
  return source;
}

const toMaterial = (item: DerivedItem): MaterialItem => ({ ...item, itemDate: toDateOnlyString(item.itemDate) });

const urlCond = Prisma.sql`sr.url IS NOT NULL AND sr.url <> ''`;

/**
 * URL → 所属する素材 (#429)。同じ URL の本文アセット (kind=text) のうち最も古いものに寄せ、無ければ URL のまま。
 * RLS 越しに引くので、見えない本文アセットには寄せない。
 */
export async function urlMaterials(tx: TransactionClient, source: DataSource, urls: string[]): Promise<Map<string, UrlMaterial>> {
  const result = new Map<string, UrlMaterial>();
  if (!urls.length) return result;
  const rows = await tx.$queryRaw<{ url: string; textId: string | null; textTitle: string | null }[]>`
    SELECT sr.url AS url,
           (array_agg(a.id ORDER BY a."createdAt", a.id) FILTER (WHERE a.kind = 'text'))[1] AS "textId",
           (array_agg(a.title ORDER BY a."createdAt", a.id) FILTER (WHERE a.kind = 'text'))[1] AS "textTitle"
    FROM "SourceRecord" sr JOIN "Asset" a ON a.id = sr."assetId"
    WHERE ${Prisma.join([urlCond, Prisma.sql`sr.url = ANY(${urls})`, ...sourcePatternConds(source)], " AND ")}
    GROUP BY sr.url
  `;
  for (const r of rows) {
    result.set(r.url, r.textId ? { key: textAssetKey(r.textId), title: r.textTitle?.trim() || null } : { key: r.url, title: null });
  }
  return result;
}

/** 素材キー → そのキーに属しうる URL。本文アセットのキーはそのアセットの URL に展開する */
async function urlsForKeys(tx: TransactionClient, source: DataSource, keys: string[]): Promise<string[]> {
  const assetIds = keys.flatMap((k) => textAssetIdOfKey(k) ?? []);
  const urls = keys.filter((k) => !textAssetIdOfKey(k));
  if (assetIds.length) {
    const rows = await tx.$queryRaw<{ url: string }[]>`
      SELECT DISTINCT sr.url AS url FROM "SourceRecord" sr
      WHERE ${Prisma.join([urlCond, Prisma.sql`sr."assetId" = ANY(${assetIds})`, ...sourcePatternConds(source)], " AND ")}
    `;
    urls.push(...rows.map((r) => r.url));
  }
  return [...new Set(urls)];
}

/**
 * URL を起点に、本文アセットごとにまとめた素材を導出する。起点の URL と同じ本文アセットに属する
 * 別の URL (雑誌の Amazon と X の告知など) も引き足し、日付をそろえる。
 */
async function deriveUrlMaterials(
  tx: TransactionClient, source: DataSource, seedUrls: string[],
): Promise<{ items: MaterialItem[]; byUrl: Map<string, UrlMaterial> }> {
  const byUrl = await urlMaterials(tx, source, seedUrls);
  const keys = new Set([...byUrl.values()].map((g) => g.key));
  const siblings = (await urlsForKeys(tx, source, [...keys].filter((k) => textAssetIdOfKey(k))))
    .filter((u) => !byUrl.has(u));
  if (siblings.length) {
    for (const [url, group] of await urlMaterials(tx, source, siblings)) if (keys.has(group.key)) byUrl.set(url, group);
  }
  const derived = byUrl.size ? (await deriveItems(tx, source, { onlyKeys: [...byUrl.keys()] })).map(toMaterial) : [];
  return { items: mergeUrlItems(derived, byUrl), byUrl };
}

/** 指定キーの素材だけを導出する (手動対象の引き足し・保存時の再導出)。ラジオは呼び出し側で扱う */
async function deriveMaterialsByKeys(tx: TransactionClient, source: DataSource, keys: string[]): Promise<MaterialItem[]> {
  if (!keys.length) return [];
  if (source.itemRule === "talk_date") return (await deriveItems(tx, source, { onlyKeys: keys })).map(toMaterial);
  const wanted = new Set(keys);
  const { items } = await deriveUrlMaterials(tx, source, await urlsForKeys(tx, source, keys));
  return items.filter((i) => wanted.has(i.itemKey));
}

/**
 * 自動で分母に入る素材。トーク (全日本人) とラジオ (出演一覧の行) は全件。
 * それ以外はソース全体 (ブログなら全メンバー約 3,000 本) を導出せず、本人著 ∪ 言及の
 * キーだけを url で引く。全体の導出は冷えた DB で数秒かかる。
 * キャッシュのキーに済の状態を含めない (含めると済を押すたびに外れる)。
 */
async function getAutomaticMaterials(
  source: DataSource, clearance: string,
): Promise<{ items: MaterialItem[]; automatic: string[]; authors: string[] }> {
  if (source.key === "radio") {
    const items = await withClearance(clearance, radioItems);
    return { items, automatic: items.map((i) => i.itemKey), authors: [] };
  }
  if (source.itemRule === "talk_date") {
    const items = (await getDerivedItems(source.key, clearance)).map(toMaterial);
    return { items, automatic: items.map((i) => i.itemKey), authors: [] };
  }
  // 導出元の getDerivedItems と同じ寿命・タグ
  return unstable_cache(async () => {
    const [authors, mentions] = await Promise.all([
      getSourceAuthorKeys(source.key, clearance), getSourceMentionKeys(source.key, clearance),
    ]);
    const { items, byUrl } = await withClearance(
      clearance, (tx) => deriveUrlMaterials(tx, source, [...new Set([...authors, ...mentions])]), { timeout: 30_000 },
    );
    // 本人著・言及は URL で判定するので、所属する本文アセットのキーに読み替える
    const keyOf = (urls: string[]) => [...new Set(urls.flatMap((u) => byUrl.get(u)?.key ?? []))];
    return { items, automatic: keyOf([...authors, ...mentions]), authors: keyOf(authors) };
  }, ["material-automatic-items-v3", source.key, clearance], { revalidate: 90, tags: ["coverage-derived-items"] })();
}

/** ページ分のアセットだけを一括取得する。URL の重複 SourceRecord でクリップを水増ししない。 */
async function assetsForItems(tx: TransactionClient, source: DataSource, items: MaterialItem[]): Promise<Map<string, MaterialAsset[]>> {
  const result = new Map<string, MaterialAsset[]>();
  if (!items.length) return result;
  let ids: { id: string }[];
  let urls: string[] | null = null;
  if (source.key === "radio") {
    const dates = [...new Set(items.flatMap((i) => i.itemDate ? [i.itemDate] : []))];
    const urls = [...new Set(items.flatMap((i) => i.sourceUrls ?? []))];
    ids = await tx.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT a.id FROM "Asset" a LEFT JOIN "SourceRecord" sr ON sr."assetId" = a.id
      WHERE sr.url = ANY(${urls}) OR ${TALK_DAY_SQL}::text = ANY(${dates})
    `;
  } else {
    const keys = items.map((i) => i.itemKey);
    let match: Prisma.Sql;
    if (source.itemRule === "talk_date") match = talkDaysSql(keys);
    else {
      urls = await urlsForKeys(tx, source, keys);
      match = Prisma.sql`sr.url = ANY(${urls})`;
    }
    ids = await tx.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT a.id FROM "Asset" a JOIN "SourceRecord" sr ON sr."assetId" = a.id
      WHERE ${Prisma.join([match, ...sourcePatternConds(source)], " AND ")}
    `;
  }
  const assets = ids.length ? await tx.asset.findMany({
    where: { id: { in: ids.map((i) => i.id) } },
    select: {
      id: true, kind: true, title: true, canonicalDate: true, classification: true,
      sourceRecords: { select: { url: true, title: true, publisher: true } },
    },
  }) : [];
  const byKey = new Map(items.map((i) => [i.itemKey, i]));
  const byUrl = urls ? await urlMaterials(tx, source, urls) : null;
  for (const asset of assets) {
    const keys = source.key === "radio"
      ? items.filter((i) => radioItemMatchesAsset(i, asset)).map((i) => i.itemKey)
      : [...new Set(itemKeysForAsset(source, asset).map((k) => byUrl?.get(k)?.key ?? k))];
    for (const key of keys) {
      if (byKey.has(key)) result.set(key, [...(result.get(key) ?? []), asset]);
    }
  }
  return result;
}

export async function listMaterialClipProgress(
  user: Actor, sourceKey: string, options: { page?: number; author?: MaterialAuthorFilter } = {},
): Promise<MaterialProgressResult> {
  const sourcePromise = getSource(sourceKey, user.clearance);
  const [source, statuses, auto] = await Promise.all([
    sourcePromise,
    withClearance(user.clearance, (tx) => tx.materialClipStatus.findMany({ where: { dataSourceKey: sourceKey } })),
    sourcePromise.then((source) => getAutomaticMaterials(source, user.clearance)),
  ]);
  const byKey = new Map(statuses.map((s) => [s.itemKey, s]));
  const automatic = new Set(auto.automatic);
  // 自動判定に漏れて手で対象にした素材 (ふつうは 0 件) だけをその場で引き足す
  const extraKeys = statuses.filter((s) => (s.included || s.done) && !automatic.has(s.itemKey)).map((s) => s.itemKey);
  const extras = extraKeys.length && source.key !== "radio" && source.itemRule !== "talk_date"
    ? await withClearance(user.clearance, (tx) => deriveMaterialsByKeys(tx, source, extraKeys))
    : [];
  const items = [...auto.items, ...extras];
  const relevant = items.filter((i) => isRelevantMaterial(i.itemKey, automatic, byKey.get(i.itemKey)));
  const authors = new Set(auto.authors);
  const byAuthor = source.key === "blog";
  const filter = byAuthor ? options.author ?? "all" : "all";
  const selected = relevant
    .filter((i) => filter === "all" || (filter === "self") === authors.has(i.itemKey))
    .sort((a, b) => (b.itemDate ?? "").localeCompare(a.itemDate ?? "") || a.itemKey.localeCompare(b.itemKey));
  const self = relevant.filter((i) => authors.has(i.itemKey)).length;
  const pageSize = 50;
  const requestedPage = Number.isFinite(options.page) ? Math.floor(options.page!) : 1;
  const page = Math.max(1, Math.min(Math.max(1, Math.ceil(selected.length / pageSize)), requestedPage));
  const pageItems = selected.slice((page - 1) * pageSize, page * pageSize);
  const rows = await withSession(user, async (tx) => {
    const assets = await assetsForItems(tx, source, pageItems);
    const assetIds = [...new Set([...assets.values()].flatMap((a) => a.map((a) => a.id)))];
    // プールだけでなく移動先も数える。非公開ドシエは所有者 RLS に従う。
    const counts = assetIds.length ? await tx.dossierItem.groupBy({
      by: ["assetId"], where: { assetId: { in: assetIds }, kind: "asset_ref" }, _count: { _all: true },
    }) : [];
    const countByAsset = new Map(counts.map((c) => [c.assetId, c._count._all]));
    return pageItems.map((item): MaterialProgressRow => {
      const status = byKey.get(item.itemKey);
      const itemAssets = assets.get(item.itemKey) ?? [];
      return {
        ...item, done: status?.done ?? false, included: status?.included ?? false,
        automatic: automatic.has(item.itemKey),
        clipCount: itemAssets.reduce((n, a) => n + (countByAsset.get(a.id) ?? 0), 0),
        // 行のリンク先。ブログは本文と画像が別アセットなので本文を優先する
        assetId: (itemAssets.find((a) => a.kind === "text") ?? itemAssets[0])?.id ?? null,
      };
    });
  }, { timeout: 30_000 });
  return {
    sourceKey, total: selected.length, done: selected.filter((i) => byKey.get(i.itemKey)?.done).length,
    authorTotals: byAuthor ? { all: relevant.length, self, others: relevant.length - self } : null,
    page, pageSize, items: rows,
  };
}

/** 保存するキーをその場で導出し直す。クライアントから機密レベルや任意の素材キーを受け取らない。 */
export async function setMaterialClipProgress(
  user: Actor, sourceKey: string, itemKey: string, change: { done: boolean } | { included: boolean },
) {
  const source = await getSource(sourceKey, user.clearance);
  const result = await withClearance(user.clearance, async (tx) => {
    // 同じ素材の並行更新を直列化し、既存 classification の読み取りと保存を一体にする。
    // 初回の行なしもロックできる。ハッシュ衝突は待機を増やすだけで状態を混ぜない。
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([sourceKey, itemKey])}, 0))`;
    const items = source.key === "radio" ? await radioItems(tx) : await deriveMaterialsByKeys(tx, source, [itemKey]);
    const item = items.find((i) => i.itemKey === itemKey);
    if (!item) throw new MaterialProgressInputError("素材が見つかりません。一覧を更新してください");
    const assets = (await assetsForItems(tx, source, [item])).get(itemKey) ?? [];
    let classification = source.classification;
    for (const asset of assets) {
      if (isAboveClearance(asset.classification, classification)) classification = asset.classification;
    }
    assertClearance(user.clearance, classification);
    const where = { dataSourceKey_itemKey: { dataSourceKey: sourceKey, itemKey } };
    const existing = await tx.materialClipStatus.findUnique({ where });
    if (existing && isAboveClearance(existing.classification, classification)) classification = existing.classification;
    assertClearance(user.clearance, classification);
    // 手動対象を外すときは済も解除する。済の解除だけでは手動対象を消さない。
    const data = "done" in change
      ? { done: change.done, ...(change.done ? { included: true } : {}) }
      : { included: change.included, ...(!change.included ? { done: false } : {}) };
    return tx.materialClipStatus.upsert({
      where,
      create: { dataSourceKey: sourceKey, itemKey, ...data, classification, updatedById: user.id },
      update: { ...data, classification, updatedById: user.id },
    });
  }, { timeout: 30_000 }).catch((error: unknown) => {
    if (isPermissionConflict(error)) throw new MaterialProgressPermissionError("現在の閲覧範囲では、この素材の共有進捗を更新できません");
    throw error;
  });
  await logAudit({ actorId: user.id, action: "material.clip-progress", targetType: "MaterialClipStatus", targetId: result.id, metadata: { sourceKey, itemKey, ...change } });
}

export interface AssetMaterialProgress extends MaterialItem { sourceKey: string; done: boolean }

/** アセット詳細でも同じ素材キーを逆引きする。トークはアセットの種類によらずその日全体。 */
export async function findMaterialClipProgressForAsset(assetId: string, clearance: string): Promise<AssetMaterialProgress[]> {
  return withClearance(clearance, async (tx) => {
    const asset = await tx.asset.findUnique({
      where: { id: assetId }, select: {
        id: true, kind: true, title: true, canonicalDate: true, classification: true,
        sourceRecords: { select: { url: true, title: true, publisher: true } },
      },
    });
    if (!asset) return [];
    const sources = await tx.dataSource.findMany({ where: { key: { in: [...MATERIAL_SOURCE_KEYS] } }, orderBy: { sortOrder: "asc" } });
    const found: (MaterialItem & { sourceKey: string })[] = [];
    for (const source of sources) {
      if (source.key === "radio") {
        for (const item of await radioItems(tx)) if (radioItemMatchesAsset(item, asset)) found.push({ ...item, sourceKey: source.key });
      } else if (source.itemRule === "talk_date") {
        for (const itemKey of itemKeysForAsset(source, asset)) found.push({
          sourceKey: source.key, itemKey, itemDate: itemKey, itemTitle: `トーク ${itemKey}`,
        });
      } else {
        const urls = itemKeysForAsset(source, asset);
        if (!urls.length) continue;
        // 同じ本文アセットに属する URL は 1 件にまとめる (#429)
        const groups = new Map([...(await urlMaterials(tx, source, urls)).values()].map((g) => [g.key, g]));
        for (const g of groups.values()) found.push({ sourceKey: source.key, itemKey: g.key, itemDate: null, itemTitle: g.title ?? asset.title });
      }
    }
    const statuses = found.length ? await tx.materialClipStatus.findMany({
      where: { OR: found.map((i) => ({ dataSourceKey: i.sourceKey, itemKey: i.itemKey })) },
    }) : [];
    const done = new Set(statuses.filter((s) => s.done).map((s) => JSON.stringify([s.dataSourceKey, s.itemKey])));
    return found.map((i) => ({ ...i, done: done.has(JSON.stringify([i.sourceKey, i.itemKey])) }));
  });
}
