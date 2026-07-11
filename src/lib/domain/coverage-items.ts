/**
 * 収集カバレッジ — アイテム一覧のトリアージ UX（v2.2）。
 *
 * v2 の素のチェックリストを、人間の実作業（言及がある記事に絞る→抜粋で当たりを付ける→
 * ドシエ登録済みかで分岐→未登録はアセットを開いて登録してから✓）を支える形に再設計する。
 * 返却するページ分のアイテムに以下をエンリッチする（アイテム毎の N+1 は禁止・バッチクエリ）:
 *
 * - mentions: 坂井新奈への言及有無（(a) AssetEntity リンク OR (b) AssetText 本文一致）。
 * - authored / authors: 坂井新奈が著者か・著者エンティティ名（roleLabel='author'）。v2.4
 * - excerpts: 一致箇所の前後スニペット（url 系・全一致をウィンドウ化、表示は最大5件＋excerptsMore で残数明示）。talk は本文先頭プレビュー（最大2件）。
 * - dossiers: アイテム所属アセットを含むドシエ（/dossiers/[id] 導線）。
 * - repAsset: 代表アセット（text 優先）。タイトルの /assets/[id] リンク先（v2.3）。
 * - imageAssets: 画像アセットのサムネイルストリップ用（v2.3）。
 *
 * 「アイテム所属アセット」= url 系は同一 SourceRecord.url のアセット群、talk はその JST 日の
 * トークアセット群。関連フィルタ（言及∪本人著・v2.4）はページング母集団を絞るため、ソース全体の
 * キー集合 (getSourceMentionKeys / getSourceAuthorKeys) を数分キャッシュして使う。
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
  // --- v2.2〜v2.4 トリアージ・エンリッチ（ページ分のみ）---
  mentions?: boolean; // 坂井新奈への言及。talk は全件本人=true。manual は undefined
  authored?: boolean; // 坂井新奈が著者（AssetEntity roleLabel='author'）。v2.4
  authors?: string[]; // 所属アセットの著者エンティティ名（重複除去）。v2.4
  excerpts?: string[]; // HTML 安全なスニペット（<mark> を含みうる）
  excerptsMore?: number; // 表示上限を超えた言及ウィンドウ数（見落とし防止のため明示。url 系のみ）
  dossiers?: { id: string; title: string }[];
  repAsset?: { id: string; kind: string } | null; // 代表アセット（text 優先・日付順先頭）。タイトルリンク先
  imageAssets?: { id: string }[]; // サムネ有り画像（先頭 MAX_IMAGE_THUMBS 件）。表示は thumbnail API（R2）のみ
  imageAssetCount?: number; // 画像アセット総数（「+N」表示用）
  assetCount?: number; // 所属アセット総数
}

export interface ListItemsResult {
  source: {
    key: string;
    name: string;
    itemRule: ItemRule;
    totalItems: number; // 導出総数（フィルタ前）
    relevantApplicable: boolean; // 関連フィルタ（言及∪本人著）が有効か（url 系のみ true）
  };
  lensKey: string | null;
  order: "asc" | "desc";
  page: number;
  pageSize: number;
  total: number; // フィルタ後の件数（ページング前）
  relevant: boolean | null; // 適用中の関連フィルタ（true=関連あり / false=関連なし / null=なし）
  items: ItemDTO[];
}

export interface ListItemsOptions {
  lensKey?: string | null;
  checked?: boolean; // lensKey 指定時のみ有効
  relevant?: boolean; // 関連フィルタ（true=言及あり∪本人著 / false=どちらでもない）。url 系のみ有効
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
// ソース全体の「坂井新奈が著者」キー集合（v2.4・url 系のみ・数分キャッシュ)
// ============================================================

async function computeSourceAuthorKeys(clearance: string, sourceKey: string): Promise<string[]> {
  // AssetEntity(entityId, roleLabel='author') の等値結合のみ（本文スキャン無し）で軽い。
  return withClearance(clearance, async (tx) => {
    const ds = await tx.dataSource.findUnique({ where: { key: sourceKey } });
    if (!ds || !itemRuleIsUrl(ds.itemRule)) return [];
    const entity = await getNinaEntity(tx);
    if (!entity) return [];

    const whereBase = Prisma.join(
      [Prisma.sql`sr.url IS NOT NULL AND sr.url <> ''`, ...sourcePatternConds(ds)],
      " AND "
    );
    const rows = await tx.$queryRaw<{ itemKey: string }[]>`
      SELECT DISTINCT sr.url AS "itemKey"
      FROM "SourceRecord" sr
      JOIN "AssetEntity" ae ON ae."assetId" = sr."assetId"
      WHERE ${whereBase} AND ae."entityId" = ${entity.id} AND ae."roleLabel" = 'author'
    `;
    return rows.map((r) => r.itemKey);
  });
}

/**
 * ソース全体の「坂井新奈が著者（roleLabel='author'）」itemKey 集合を返す（url 系のみ非空）。
 * 本人ブログには本人への言及が無いことがあるため、関連判定は 言及 ∪ 本人著 の2軸（v2.4）。
 * getSourceMentionKeys と同構造・同キャッシュ方式（120秒・source×clearance キー）。
 */
export async function getSourceAuthorKeys(sourceKey: string, clearance: string): Promise<string[]> {
  const cached = unstable_cache(
    () => computeSourceAuthorKeys(clearance, sourceKey),
    ["coverage-author-keys", sourceKey, clearance],
    { revalidate: 120, tags: ["coverage-author-keys"] }
  );
  return cached();
}

// ============================================================
// スニペット生成ヘルパー（HTML 安全 + <mark> ハイライト）
// ============================================================

const MAX_IMAGE_THUMBS = 8;
const MAX_EXCERPTS_URL = 5;
const MAX_EXCERPTS_TALK = 2;
const SNIPPET_RADIUS = 60;
const TALK_PREVIEW_LEN = 140;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** block 内の**全**一致箇所を、前後 ~SNIPPET_RADIUS 字のウィンドウとして返す。
 * 近接・重複するウィンドウはマージ（1スニペットに複数の <mark> が入る）。
 * 「最初の一致だけ拾って以降の離れた言及を見落とす」事故を防ぐため、必ず全件拾う。 */
function allMatchWindows(block: string, terms: string[]): { start: number; end: number }[] {
  const escaped = terms.map(regexEscape).filter(Boolean);
  if (escaped.length === 0) return [];
  const re = new RegExp(escaped.join("|"), "gi");
  const windows: { start: number; end: number }[] = [];
  for (const m of block.matchAll(re)) {
    const start = Math.max(0, m.index - SNIPPET_RADIUS);
    const end = Math.min(block.length, m.index + m[0].length + SNIPPET_RADIUS);
    const last = windows[windows.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end); // マージ
    else windows.push({ start, end });
  }
  return windows;
}

/** ウィンドウ範囲を切り出し、HTML エスケープ後に一致語を <mark> で囲む。 */
function windowSnippet(block: string, terms: string[], win: { start: number; end: number }): string {
  const seg = block.slice(win.start, win.end);
  const prefix = win.start > 0 ? "…" : "";
  const suffix = win.end < block.length ? "…" : "";
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

  // 著者（AssetEntity roleLabel='author' の Entity 名）。v2.4・バッチ1クエリ
  const authorsByAsset = new Map<string, string[]>();
  if (assetIdArr.length > 0) {
    const auRows = await tx.$queryRaw<{ assetId: string; name: string }[]>`
      SELECT ae."assetId" AS "assetId", e."canonicalName" AS "name"
      FROM "AssetEntity" ae
      JOIN "Entity" e ON e.id = ae."entityId"
      WHERE ae."assetId" = ANY(${assetIdArr}) AND ae."roleLabel" = 'author'
    `;
    for (const r of auRows) pushMap(authorsByAsset, r.assetId, r.name);
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

    // 著者名（所属アセット横断で重複除去・日付順）
    const authorSet = new Set<string>();
    for (const r of rowsForItem) {
      for (const n of authorsByAsset.get(r.assetId) ?? []) authorSet.add(n);
    }
    item.authors = [...authorSet];

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
      // url: 一致箇所スニペット。**全一致箇所**をウィンドウ化して拾い（近接はマージ）、
      // 表示上限を超えた分は excerptsMore で件数を明示する（黙って切り捨てない）。
      const excerpts: string[] = [];
      let total = 0;
      for (const r of rowsForItem) {
        for (const content of textsByAsset.get(r.assetId) ?? []) {
          for (const rawBlock of content.split(/\n{2,}/)) {
            const block = rawBlock.trim();
            if (!block) continue;
            for (const win of allMatchWindows(block, terms)) {
              total++;
              if (excerpts.length < MAX_EXCERPTS_URL) {
                excerpts.push(windowSnippet(block, terms, win));
              }
            }
          }
        }
      }
      item.excerpts = excerpts;
      if (total > excerpts.length) item.excerptsMore = total - excerpts.length;
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

  // ソース全体の言及あり/本人著キー（url 系のみ非空）と導出アイテム。すべてキャッシュ付き独立 tx。
  const [mentionKeyArr, authorKeyArr, derived] = await Promise.all([
    getSourceMentionKeys(sourceKey, actor.clearance),
    getSourceAuthorKeys(sourceKey, actor.clearance),
    getDerivedItems(sourceKey, actor.clearance),
  ]);
  const mentionSet = new Set(mentionKeyArr);
  const authorSet = new Set(authorKeyArr);

  return withSession(actor, async (tx) => {
    const ds = await tx.dataSource.findUnique({ where: { key: sourceKey } });
    if (!ds) throw new Error(`DataSource not found: ${sourceKey}`);

    const isUrl = itemRuleIsUrl(ds.itemRule);
    const isTalk = ds.itemRule === "talk_date";
    const relevantApplicable = isUrl; // talk=全件本人 / manual=アイテム無し

    const mentionOf = (key: string): boolean | undefined =>
      relevantApplicable ? mentionSet.has(key) : isTalk ? true : undefined;
    const authoredOf = (key: string): boolean | undefined =>
      relevantApplicable ? authorSet.has(key) : isTalk ? true : undefined;
    // 関連 = 言及 ∪ 本人著（v2.4）
    const isRelevant = (key: string): boolean => mentionSet.has(key) || authorSet.has(key);

    // 関連フィルタ（母集団を絞る。url 系のみ）
    let filtered: DerivedItem[] = derived;
    if (relevantApplicable && opts.relevant === true) {
      filtered = filtered.filter((d) => isRelevant(d.itemKey));
    } else if (relevantApplicable && opts.relevant === false) {
      filtered = filtered.filter((d) => !isRelevant(d.itemKey));
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
        authored: authoredOf(d.itemKey),
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
        authored: authoredOf(d.itemKey),
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
        relevantApplicable,
      },
      lensKey: opts.lensKey ?? null,
      order,
      page,
      pageSize,
      total,
      relevant: relevantApplicable ? opts.relevant ?? null : null,
      items: pageItems,
    };
  });
}

// ============================================================
// アセット → 所属カバレッジアイテムの逆引き (findItemsForAsset) — v2.4
// ============================================================

export interface AssetCoverageItem {
  sourceKey: string;
  sourceName: string;
  itemRule: ItemRule;
  itemKey: string; // url または "YYYY-MM-DD"
  itemTitle: string | null;
  checkedLensKeys: string[]; // 現在のチェック状態（全観点）
}

/**
 * SQL LIKE パターン（% と _）を JS の正規表現に変換する（大文字小文字は区別 = Postgres LIKE と同じ）。
 * `|` OR は呼び出し側で分割する。
 */
function likeToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, "[\\s\\S]*")
    .replace(/_/g, "[\\s\\S]");
  return new RegExp(`^${escaped}$`);
}

/** 値が `|` 区切り LIKE パターンのいずれかに一致するか。パターン空/null は不問(true)。 */
function matchesLikeOr(value: string | null | undefined, pattern: string | null): boolean {
  const parts = (pattern ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return true;
  const v = value ?? "";
  return parts.some((p) => likeToRegex(p).test(v));
}

/** canonicalDate（UTC naive 格納）→ JST 壁時計の "YYYY-MM-DD"（deriveItems の talk_date と同じ規約）。 */
function jstDayString(d: Date): string {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * アセットが属するカバレッジアイテムを逆引きする（アセットページ内チェックパネル用・v2.4）。
 * アセットの SourceRecord.url / canonicalDate(JST日) を、derivable な各 DataSource の
 * publisher/title パターン（LIKE・`|` OR）とアプリ側で突き合わせる。通常 0〜1 件。
 * クエリはアセット1・データソース1・チェック1 の計3本（アイテム毎の導出クエリは発行しない）。
 */
export async function findItemsForAsset(
  assetId: string,
  clearance: string
): Promise<AssetCoverageItem[]> {
  return withClearance(clearance, async (tx) => {
    const asset = await tx.asset.findUnique({
      where: { id: assetId },
      select: {
        id: true,
        canonicalDate: true,
        sourceRecords: { select: { url: true, publisher: true, title: true } },
      },
    });
    if (!asset || asset.sourceRecords.length === 0) return [];

    const sources = await tx.dataSource.findMany({
      where: { active: true, itemRule: { not: "manual" } },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });

    const found: {
      ds: (typeof sources)[number];
      itemKey: string;
      itemTitle: string | null;
    }[] = [];
    const seen = new Set<string>();

    for (const ds of sources) {
      const matching = asset.sourceRecords.filter(
        (sr) =>
          matchesLikeOr(sr.publisher, ds.publisherPattern) &&
          matchesLikeOr(sr.title, ds.titlePattern)
      );
      if (matching.length === 0) continue;

      if (ds.itemRule === "talk_date") {
        if (!asset.canonicalDate) continue; // 導出対象外（deriveItems と同条件）
        const day = jstDayString(asset.canonicalDate);
        const dedupe = `${ds.id}:${day}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        found.push({ ds, itemKey: day, itemTitle: `トーク ${day}` });
      } else {
        // blog_url / source_url — url を持つ SourceRecord のみアイテムになる
        for (const sr of matching) {
          if (!sr.url) continue;
          const dedupe = `${ds.id}:${sr.url}`;
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          found.push({ ds, itemKey: sr.url, itemTitle: sr.title || null });
        }
      }
    }
    if (found.length === 0) return [];

    // 現在のチェック状態（全観点）を1クエリで
    const checks = await tx.lensItemCheck.findMany({
      where: { OR: found.map((f) => ({ dataSourceId: f.ds.id, itemKey: f.itemKey })) },
      select: { dataSourceId: true, itemKey: true, lens: { select: { key: true } } },
    });
    const checkedByItem = new Map<string, string[]>();
    for (const c of checks) pushMap(checkedByItem, `${c.dataSourceId}:${c.itemKey}`, c.lens.key);

    return found.map((f) => ({
      sourceKey: f.ds.key,
      sourceName: f.ds.name,
      itemRule: f.ds.itemRule,
      itemKey: f.itemKey,
      itemTitle: f.itemTitle,
      checkedLensKeys: checkedByItem.get(`${f.ds.id}:${f.itemKey}`) ?? [],
    }));
  });
}
