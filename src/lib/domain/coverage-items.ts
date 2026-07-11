/**
 * 収集カバレッジ — アイテム一覧のトリアージ UX（v2.2）。
 *
 * v2 の素のチェックリストを、人間の実作業（言及がある記事に絞る→抜粋で当たりを付ける→
 * ドシエ登録済みかで分岐→未登録はアセットを開いて登録してから✓）を支える形に再設計する。
 * 返却するページ分のアイテムに以下をエンリッチする（アイテム毎の N+1 は禁止・バッチクエリ）:
 *
 * - mentions: 坂井新奈への言及有無（(a) AssetEntity リンク OR (b) AssetText 本文一致）。
 * - excerpts: 一致箇所の前後スニペット（url 系・最大3件）。talk は本文先頭プレビュー（最大2件）。
 * - dossiers: アイテム所属アセットを含むドシエ（/dossiers/[id] 導線）。
 * - repAsset: 代表アセット（text 優先）。タイトルの /assets/[id] リンク先（v2.3）。
 * - imageAssets: 画像アセットのサムネイルストリップ用（v2.3）。
 *
 * 「アイテム所属アセット」= url 系は同一 SourceRecord.url のアセット群、talk はその JST 日の
 * トークアセット群。言及フィルタはページング母集団を絞るため、ソース全体の言及ありキー集合
 * (getSourceMentionKeys) を数分キャッシュして使う（内部管理画面なので許容）。
 *
 * 坂井新奈エンティティ（type=person, canonicalName='坂井新奈'）は Entity テーブルから引く
 * （ハードコードしない）。canonicalName + aliases を一致語に使う。
 */

import { ItemRule, Prisma } from "@prisma/client";
import { unstable_cache } from "next/cache";
import { withClearance, withSession, type TransactionClient } from "@/lib/db";
import {
  getDerivedItems,
  itemRuleIsUrl,
  sourcePatternConds,
  toDateOnlyString,
  TALK_DAY_SQL,
  type DerivedItem,
} from "./coverage";

// ============================================================
// DTO
// ============================================================

export interface ItemDTO {
  itemKey: string;
  itemDate: string | null; // YYYY-MM-DD
  itemTitle: string | null;
  isUrl: boolean;
  checked?: boolean; // lensKey 指定時
  checkedLensKeys?: string[]; // lensKey 省略時（アイテム起点ビュー）
  // --- v2.2/v2.3 トリアージ・エンリッチ（ページ分のみ）---
  mentions?: boolean; // 坂井新奈への言及。talk は全件本人=true。manual は undefined
  excerpts?: string[]; // HTML 安全なスニペット（<mark> を含みうる）
  dossiers?: { id: string; title: string }[];
  repAsset?: { id: string; kind: string } | null; // 代表アセット（text 優先・日付順先頭）。タイトルリンク先
  imageAssets?: { id: string }[]; // サムネイル有りの画像アセット（先頭 MAX_IMAGE_THUMBS 件）
  imageAssetCount?: number; // 画像アセット総数（「+N」表示用）
  assetCount?: number; // 所属アセット総数
}

export interface ListItemsResult {
  source: {
    key: string;
    name: string;
    itemRule: ItemRule;
    totalItems: number; // 導出総数（フィルタ前）
    mentionApplicable: boolean; // 言及フィルタが有効か（url 系のみ true）
  };
  lensKey: string | null;
  order: "asc" | "desc";
  page: number;
  pageSize: number;
  total: number; // フィルタ後の件数（ページング前）
  mentions: boolean | null; // 適用中の言及フィルタ（true=言及あり / false=言及なし / null=なし）
  items: ItemDTO[];
}

export interface ListItemsOptions {
  lensKey?: string | null;
  checked?: boolean; // lensKey 指定時のみ有効
  mentions?: boolean; // 言及フィルタ（true=言及あり / false=言及なし）。url 系のみ有効
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

// ============================================================
// 坂井新奈エンティティ（Entity テーブルから引く。ハードコードしない）
// ============================================================

interface NinaEntity {
  id: string;
  terms: string[]; // canonicalName + aliases
}

async function getNinaEntity(tx: TransactionClient): Promise<NinaEntity | null> {
  const e = await tx.entity.findUnique({
    where: { type_canonicalName: { type: "person", canonicalName: "坂井新奈" } },
    select: { id: true, canonicalName: true, aliases: true },
  });
  if (!e) return null;
  const aliases = Array.isArray(e.aliases)
    ? (e.aliases as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  const terms = Array.from(new Set([e.canonicalName, ...aliases].filter(Boolean)));
  return { id: e.id, terms };
}

// ============================================================
// ソース全体の言及ありキー集合（url 系のみ・数分キャッシュ）
// ============================================================

async function computeSourceMentionKeys(clearance: string, sourceKey: string): Promise<string[]> {
  // AssetText 全体への ILIKE スキャン（一致語 16 種 OR）はソースが大きいと重いので
  // 独立 tx ＋ 30s タイムアウト（db.ts 既定 15s のさらに上）で流す。結果はキャッシュされる。
  return withClearance(
    clearance,
    async (tx) => {
    const ds = await tx.dataSource.findUnique({ where: { key: sourceKey } });
    if (!ds || !itemRuleIsUrl(ds.itemRule)) return [];
    const entity = await getNinaEntity(tx);
    if (!entity) return [];

    const whereBase = Prisma.join(
      [Prisma.sql`sr.url IS NOT NULL AND sr.url <> ''`, ...sourcePatternConds(ds)],
      " AND "
    );

    // (a) 坂井新奈への AssetEntity リンクを持つアセットの url
    const aRows = await tx.$queryRaw<{ itemKey: string }[]>`
      SELECT DISTINCT sr.url AS "itemKey"
      FROM "SourceRecord" sr
      JOIN "AssetEntity" ae ON ae."assetId" = sr."assetId"
      WHERE ${whereBase} AND ae."entityId" = ${entity.id}
    `;

    // (b) 本文が canonicalName/aliases のいずれかに一致するアセットの url
    let bRows: { itemKey: string }[] = [];
    if (entity.terms.length > 0) {
      const termConds = entity.terms.map((t) => Prisma.sql`t."content" ILIKE ${"%" + t + "%"}`);
      bRows = await tx.$queryRaw<{ itemKey: string }[]>`
        SELECT DISTINCT sr.url AS "itemKey"
        FROM "SourceRecord" sr
        JOIN "AssetText" t ON t."assetId" = sr."assetId"
        WHERE ${whereBase} AND (${Prisma.join(termConds, " OR ")})
      `;
    }

    const set = new Set<string>();
    for (const r of aRows) set.add(r.itemKey);
    for (const r of bRows) set.add(r.itemKey);
    return Array.from(set);
    },
    { timeout: 30_000 }
  );
}

/**
 * ソース全体の「坂井新奈への言及あり」itemKey 集合を返す（url 系のみ非空）。
 * 言及フィルタのページング母集団・行の言及バッジ・bulk の onlyMentionless で共有する。
 * unstable_cache で 120 秒キャッシュ（source×clearance でキー）。内部管理画面なので許容。
 */
export async function getSourceMentionKeys(sourceKey: string, clearance: string): Promise<string[]> {
  const cached = unstable_cache(
    () => computeSourceMentionKeys(clearance, sourceKey),
    ["coverage-mention-keys", sourceKey, clearance],
    { revalidate: 120, tags: ["coverage-mention-keys"] }
  );
  return cached();
}

// ============================================================
// スニペット生成ヘルパー（HTML 安全 + <mark> ハイライト）
// ============================================================

const MAX_IMAGE_THUMBS = 8;
const MAX_EXCERPTS_URL = 3;
const MAX_EXCERPTS_TALK = 2;
const SNIPPET_RADIUS = 60;
const TALK_PREVIEW_LEN = 140;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** block 内で最初に一致する一致語の位置を返す（大文字小文字無視）。 */
function firstMatch(block: string, terms: string[]): { index: number; term: string } | null {
  const lower = block.toLowerCase();
  let best: { index: number; term: string } | null = null;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (best === null || i < best.index)) best = { index: i, term: t };
  }
  return best;
}

/** 一致箇所の前後 ~SNIPPET_RADIUS 字を切り出し、HTML エスケープ後に一致語を <mark> で囲む。 */
function markedSnippet(block: string, terms: string[], match: { index: number; term: string }): string {
  const start = Math.max(0, match.index - SNIPPET_RADIUS);
  const end = Math.min(block.length, match.index + match.term.length + SNIPPET_RADIUS);
  const seg = block.slice(start, end);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < block.length ? "…" : "";
  let html = escapeHtml(seg);
  const escaped = terms.map((t) => regexEscape(escapeHtml(t))).filter(Boolean);
  if (escaped.length > 0) {
    const re = new RegExp(`(${escaped.join("|")})`, "gi");
    html = html.replace(re, "<mark>$1</mark>");
  }
  return prefix + html + suffix;
}

/** 先頭プレビュー用。切り詰めて HTML エスケープ（<mark> なし）。 */
function truncEscape(s: string, len: number): string {
  const t = s.length > len ? s.slice(0, len) + "…" : s;
  return escapeHtml(t);
}

// ============================================================
// ページ分アイテムのエンリッチ（バッチクエリ）
// ============================================================

interface AssetRow {
  itemKey: string;
  assetId: string;
  kind: string;
  canonicalDate: Date | null;
  preview: string | null;
  hasThumb: boolean; // thumbnailUrl IS NOT NULL（サムネイルストリップ用）
}

function byDateAsc(a: AssetRow, b: AssetRow): number {
  const ta = a.canonicalDate ? a.canonicalDate.getTime() : Number.POSITIVE_INFINITY;
  const tb = b.canonicalDate ? b.canonicalDate.getTime() : Number.POSITIVE_INFINITY;
  return ta - tb;
}

function pushMap<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

/**
 * ページ分のアイテムに dossiers / assets / excerpts を付与する（items を直接ミューテート）。
 * クエリは有界: アセット取得 1・ドシエ 1・（url のみ）本文 1 の計 2〜3 本。
 */
async function enrichPageItems(
  tx: TransactionClient,
  ds: { itemRule: ItemRule; publisherPattern: string | null; titlePattern: string | null },
  items: ItemDTO[],
  isTalk: boolean
): Promise<void> {
  if (items.length === 0) return;
  const isUrl = itemRuleIsUrl(ds.itemRule);
  if (!isUrl && !isTalk) return; // manual: エンリッチ対象なし

  const pageKeys = items.map((i) => i.itemKey);

  // アイテム所属アセット（url=同一 url / talk=同一 JST 日）
  let rows: AssetRow[];
  if (isTalk) {
    const conds = [
      Prisma.sql`a."canonicalDate" IS NOT NULL`,
      ...sourcePatternConds(ds),
      Prisma.sql`${TALK_DAY_SQL}::text = ANY(${pageKeys})`,
    ];
    rows = await tx.$queryRaw<AssetRow[]>`
      SELECT DISTINCT ${TALK_DAY_SQL}::text AS "itemKey", a.id AS "assetId", a.kind::text AS "kind",
             a."canonicalDate" AS "canonicalDate", a."messageBodyPreview" AS "preview",
             (a."thumbnailUrl" IS NOT NULL) AS "hasThumb"
      FROM "Asset" a
      JOIN "SourceRecord" sr ON sr."assetId" = a.id
      WHERE ${Prisma.join(conds, " AND ")}
    `;
  } else {
    const conds = [
      Prisma.sql`sr.url IS NOT NULL AND sr.url <> ''`,
      ...sourcePatternConds(ds),
      Prisma.sql`sr.url = ANY(${pageKeys})`,
    ];
    rows = await tx.$queryRaw<AssetRow[]>`
      SELECT DISTINCT sr.url AS "itemKey", a.id AS "assetId", a.kind::text AS "kind",
             a."canonicalDate" AS "canonicalDate", a."messageBodyPreview" AS "preview",
             (a."thumbnailUrl" IS NOT NULL) AS "hasThumb"
      FROM "SourceRecord" sr
      JOIN "Asset" a ON a.id = sr."assetId"
      WHERE ${Prisma.join(conds, " AND ")}
    `;
  }

  const assetsByItem = new Map<string, AssetRow[]>();
  const assetToItems = new Map<string, Set<string>>();
  const allAssetIds = new Set<string>();
  for (const r of rows) {
    pushMap(assetsByItem, r.itemKey, r);
    let s = assetToItems.get(r.assetId);
    if (!s) {
      s = new Set();
      assetToItems.set(r.assetId, s);
    }
    s.add(r.itemKey);
    allAssetIds.add(r.assetId);
  }
  const assetIdArr = Array.from(allAssetIds);

  // ドシエ（所属アセットを含むドシエ。withSession の owner RLS が適用される）
  const dossiersByItem = new Map<string, Map<string, string>>();
  if (assetIdArr.length > 0) {
    const dRows = await tx.$queryRaw<{ assetId: string; dossierId: string; title: string }[]>`
      SELECT DISTINCT di."assetId" AS "assetId", d.id AS "dossierId", d.title AS "title"
      FROM "DossierItem" di
      JOIN "Dossier" d ON d.id = di."dossierId"
      WHERE di."assetId" = ANY(${assetIdArr})
    `;
    for (const dr of dRows) {
      const keys = assetToItems.get(dr.assetId);
      if (!keys) continue;
      for (const k of keys) {
        let m = dossiersByItem.get(k);
        if (!m) {
          m = new Map();
          dossiersByItem.set(k, m);
        }
        m.set(dr.dossierId, dr.title);
      }
    }
  }

  // 本文（url 系のみ。talk は messageBodyPreview を使うので取得しない）
  const textsByAsset = new Map<string, string[]>();
  let terms: string[] = [];
  if (isUrl && assetIdArr.length > 0) {
    const entity = await getNinaEntity(tx);
    terms = entity?.terms ?? [];
    const tRows = await tx.$queryRaw<{ assetId: string; content: string }[]>`
      SELECT t."assetId" AS "assetId", t."content" AS "content"
      FROM "AssetText" t
      WHERE t."assetId" = ANY(${assetIdArr})
    `;
    for (const tr of tRows) pushMap(textsByAsset, tr.assetId, tr.content);
  }

  for (const item of items) {
    const rowsForItem = (assetsByItem.get(item.itemKey) ?? []).slice().sort(byDateAsc);

    item.assetCount = rowsForItem.length;

    // 代表アセット（text 優先・日付順先頭）= タイトルリンク先（v2.3）
    const rep = rowsForItem.find((r) => r.kind === "text") ?? rowsForItem[0] ?? null;
    item.repAsset = rep ? { id: rep.assetId, kind: rep.kind } : null;

    // 画像アセットのサムネイルストリップ用（thumbnail 有りのみ・先頭 MAX_IMAGE_THUMBS 件）
    const imageRows = rowsForItem.filter((r) => r.kind === "image");
    item.imageAssetCount = imageRows.length;
    item.imageAssets = imageRows
      .filter((r) => r.hasThumb)
      .slice(0, MAX_IMAGE_THUMBS)
      .map((r) => ({ id: r.assetId }));

    const dm = dossiersByItem.get(item.itemKey);
    item.dossiers = dm ? Array.from(dm, ([id, title]) => ({ id, title })) : [];

    if (isTalk) {
      // talk: 本文先頭プレビュー（最大2件・言及判定なし）
      const previews: string[] = [];
      for (const r of rowsForItem) {
        const p = (r.preview ?? "").trim();
        if (!p) continue;
        previews.push(truncEscape(p, TALK_PREVIEW_LEN));
        if (previews.length >= MAX_EXCERPTS_TALK) break;
      }
      item.excerpts = previews;
    } else {
      // url: 一致箇所スニペット（最大3件）
      const excerpts: string[] = [];
      outer: for (const r of rowsForItem) {
        for (const content of textsByAsset.get(r.assetId) ?? []) {
          for (const rawBlock of content.split(/\n{2,}/)) {
            const block = rawBlock.trim();
            if (!block) continue;
            const m = firstMatch(block, terms);
            if (!m) continue;
            excerpts.push(markedSnippet(block, terms, m));
            if (excerpts.length >= MAX_EXCERPTS_URL) break outer;
          }
        }
      }
      item.excerpts = excerpts;
    }
  }
}

// ============================================================
// アイテム一覧 (listItems)
// ============================================================

/**
 * ソースのアイテム一覧を返す（トリアージ・エンリッチ込み）。
 * lensKey 指定時は当該観点の checked フラグと checked フィルタ、省略時は全観点の
 * checkedLensKeys を各アイテムに付ける（アイテム起点ビュー）。昇順が既定。
 *
 * P2028 対策: 導出（重い集約）は getDerivedItems（キャッシュ付き独立 tx）から取り、
 * withSession の tx 内では「チェック取得＋ページ分のエンリッチ」だけを行う。
 * withSession（app.user_id 付き）なのはドシエの owner ベース RLS のため。
 */
export async function listItems(
  sourceKey: string,
  opts: ListItemsOptions,
  actor: { id: string; clearance: string }
): Promise<ListItemsResult> {
  const order: "asc" | "desc" = opts.order === "desc" ? "desc" : "asc";
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, opts.pageSize ?? 100));

  // ソース全体の言及ありキー（url 系のみ非空）と導出アイテム。どちらもキャッシュ付き独立 tx。
  const [mentionKeyArr, derived] = await Promise.all([
    getSourceMentionKeys(sourceKey, actor.clearance),
    getDerivedItems(sourceKey, actor.clearance),
  ]);
  const mentionSet = new Set(mentionKeyArr);

  return withSession(actor, async (tx) => {
    const ds = await tx.dataSource.findUnique({ where: { key: sourceKey } });
    if (!ds) throw new Error(`DataSource not found: ${sourceKey}`);

    const isUrl = itemRuleIsUrl(ds.itemRule);
    const isTalk = ds.itemRule === "talk_date";
    const mentionApplicable = isUrl; // talk=全件本人 / manual=アイテム無し

    const mentionOf = (key: string): boolean | undefined =>
      mentionApplicable ? mentionSet.has(key) : isTalk ? true : undefined;

    // 言及フィルタ（母集団を絞る。url 系のみ）
    let filtered: DerivedItem[] = derived;
    if (mentionApplicable && opts.mentions === true) {
      filtered = filtered.filter((d) => mentionSet.has(d.itemKey));
    } else if (mentionApplicable && opts.mentions === false) {
      filtered = filtered.filter((d) => !mentionSet.has(d.itemKey));
    }

    let items: ItemDTO[];
    if (opts.lensKey) {
      const lens = await tx.lens.findUnique({ where: { key: opts.lensKey } });
      if (!lens) throw new Error(`Lens not found: ${opts.lensKey}`);
      const checks = await tx.lensItemCheck.findMany({
        where: { lensId: lens.id, dataSourceId: ds.id },
        select: { itemKey: true },
      });
      const checkedSet = new Set(checks.map((c) => c.itemKey));
      items = filtered.map((d) => ({
        itemKey: d.itemKey,
        itemDate: toDateOnlyString(d.itemDate),
        itemTitle: d.itemTitle,
        isUrl,
        mentions: mentionOf(d.itemKey),
        checked: checkedSet.has(d.itemKey),
      }));
      if (opts.checked === true) items = items.filter((i) => i.checked);
      else if (opts.checked === false) items = items.filter((i) => !i.checked);
    } else {
      const checks = await tx.lensItemCheck.findMany({
        where: { dataSourceId: ds.id },
        select: { itemKey: true, lens: { select: { key: true } } },
      });
      const byItem = new Map<string, string[]>();
      for (const c of checks) pushMap(byItem, c.itemKey, c.lens.key);
      items = filtered.map((d) => ({
        itemKey: d.itemKey,
        itemDate: toDateOnlyString(d.itemDate),
        itemTitle: d.itemTitle,
        isUrl,
        mentions: mentionOf(d.itemKey),
        checkedLensKeys: byItem.get(d.itemKey) ?? [],
      }));
    }

    if (order === "desc") items.reverse();

    const total = items.length;
    const start = (page - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);

    // ページ分だけをエンリッチ（dossier/asset/excerpt）。N+1 なしのバッチクエリ。
    await enrichPageItems(tx, ds, pageItems, isTalk);

    return {
      source: {
        key: ds.key,
        name: ds.name,
        itemRule: ds.itemRule,
        totalItems: derived.length,
        mentionApplicable,
      },
      lensKey: opts.lensKey ?? null,
      order,
      page,
      pageSize,
      total,
      mentions: mentionApplicable ? opts.mentions ?? null : null,
      items: pageItems,
    };
  });
}
