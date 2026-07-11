/**
 * 収集カバレッジ管理 (観点 × データソース) のドメイン層 — v2（アイテム単位チェック）。
 *
 * v1 は「セルに手動の日付カーソル(collectedUntil)」を持っていたが、v2 では
 * チェックの最小単位を **アイテム**（ソースごとの投稿/ドキュメント単位）にした。
 * アイテムはテーブル実体化せず、DataSource.itemRule に従って SourceRecord/Asset から
 * 導出する（導出ビュー）。セルの表示値（済/総・「〜◯日まで反映済み」）は
 * LensItemCheck からの導出値。
 *
 * Lens / DataSource / Coverage / LensItemCheck は RLS 有効（direct-classification）。
 * owner ベースは無いので withClearance(clearance, ...) で十分。導出クエリ($queryRaw)も
 * withClearance の tx 経由で流すため、Asset/SourceRecord の RLS が自動で効く。
 * 日付は TZ 事故回避のため常に UTC 00:00 に正規化し、外向きには YYYY-MM-DD 文字列で扱う。
 */

import { ClearanceLevel, CoverageStatus, DataSourceKind, ItemRule, Prisma } from "@prisma/client";
import { unstable_cache } from "next/cache";
import { withClearance, type TransactionClient } from "@/lib/db";
import { logAudit } from "./audit";
import { getSourceMentionKeys } from "./coverage-items";

// ============================================================
// 日付正規化 (YYYY-MM-DD <-> Date(UTC 00:00))
// ============================================================

/** Date -> "YYYY-MM-DD"（UTC 基準）。null はそのまま null。 */
export function toDateOnlyString(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" -> Date(UTC 00:00)。空/undefined は null。不正な形式は例外。 */
export function parseDateOnly(s: string | null | undefined): Date | null {
  if (s == null || s === "") return null;
  const trimmed = s.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(`Invalid date (expected YYYY-MM-DD): ${s}`);
  }
  const d = new Date(`${trimmed}T00:00:00.000Z`);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}

/** 今日 (JST) を Date(UTC 00:00) で返す。
 * このプロダクトの日付ドメインは日本時間（ブログ日付・運用者とも JST）。
 * 格納規約は「YYYY-MM-DD の UTC 00:00」で不変。 */
export function todayDateOnly(): Date {
  // en-CA ロケールは YYYY-MM-DD 形式を返す
  const jst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
  return new Date(jst + "T00:00:00.000Z");
}

// ============================================================
// Lens (観点)
// ============================================================

export interface CreateLensInput {
  key: string;
  name: string;
  description?: string;
  sortOrder?: number;
  public?: boolean;
  classification?: ClearanceLevel;
}

export interface UpdateLensInput {
  name?: string;
  description?: string;
  sortOrder?: number;
  active?: boolean;
  public?: boolean;
  classification?: ClearanceLevel;
}

export async function listLenses(clearance: string, includeInactive = true) {
  return withClearance(clearance, (tx) =>
    tx.lens.findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    })
  );
}

export async function createLens(
  input: CreateLensInput,
  clearance: string,
  actorId?: string | null
) {
  const key = input.key.trim();
  if (!/^[a-z][a-z0-9_]*$/.test(key)) {
    throw new Error("key は小文字英数字とアンダースコアのみ（先頭は英字）");
  }
  const lens = await withClearance(clearance, (tx) =>
    tx.lens.create({
      data: {
        key,
        name: input.name.trim(),
        description: input.description ?? "",
        sortOrder: input.sortOrder ?? 0,
        public: input.public ?? true,
        classification: input.classification ?? "internal",
      },
    })
  );

  await logAudit({
    actorId,
    action: "lens.create",
    targetType: "Lens",
    targetId: lens.id,
    metadata: { key: lens.key, name: lens.name },
  });

  return lens;
}

/** key は作成後変更不可。渡されても無視する。 */
export async function updateLens(
  id: string,
  input: UpdateLensInput,
  clearance: string,
  actorId?: string | null
) {
  const lens = await withClearance(clearance, (tx) =>
    tx.lens.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.public !== undefined ? { public: input.public } : {}),
        ...(input.classification !== undefined
          ? { classification: input.classification }
          : {}),
      },
    })
  );

  await logAudit({
    actorId,
    action: "lens.update",
    targetType: "Lens",
    targetId: lens.id,
    metadata: input as unknown as Record<string, unknown>,
  });

  return lens;
}

// ============================================================
// DataSource (データソース)
// ============================================================

export interface CreateDataSourceInput {
  key: string;
  name: string;
  kind: DataSourceKind;
  description?: string | null;
  sortOrder?: number;
  public?: boolean;
  classification?: ClearanceLevel;
  itemRule?: ItemRule;
  publisherPattern?: string | null;
  titlePattern?: string | null;
}

export interface UpdateDataSourceInput {
  name?: string;
  kind?: DataSourceKind;
  description?: string | null;
  sortOrder?: number;
  active?: boolean;
  public?: boolean;
  classification?: ClearanceLevel;
  itemRule?: ItemRule;
  publisherPattern?: string | null;
  titlePattern?: string | null;
}

export async function listDataSources(clearance: string, includeInactive = true) {
  return withClearance(clearance, (tx) =>
    tx.dataSource.findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    })
  );
}

export async function createDataSource(
  input: CreateDataSourceInput,
  clearance: string,
  actorId?: string | null
) {
  const key = input.key.trim();
  if (!/^[a-z][a-z0-9_]*$/.test(key)) {
    throw new Error("key は小文字英数字とアンダースコアのみ（先頭は英字）");
  }
  const ds = await withClearance(clearance, (tx) =>
    tx.dataSource.create({
      data: {
        key,
        name: input.name.trim(),
        kind: input.kind,
        description: input.description ?? null,
        sortOrder: input.sortOrder ?? 0,
        public: input.public ?? true,
        classification: input.classification ?? "internal",
        itemRule: input.itemRule ?? "manual",
        publisherPattern: input.publisherPattern ?? null,
        titlePattern: input.titlePattern ?? null,
      },
    })
  );

  await logAudit({
    actorId,
    action: "datasource.create",
    targetType: "DataSource",
    targetId: ds.id,
    metadata: { key: ds.key, name: ds.name },
  });

  return ds;
}

/** key は作成後変更不可。渡されても無視する。 */
export async function updateDataSource(
  id: string,
  input: UpdateDataSourceInput,
  clearance: string,
  actorId?: string | null
) {
  const ds = await withClearance(clearance, (tx) =>
    tx.dataSource.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.public !== undefined ? { public: input.public } : {}),
        ...(input.classification !== undefined
          ? { classification: input.classification }
          : {}),
        ...(input.itemRule !== undefined ? { itemRule: input.itemRule } : {}),
        ...(input.publisherPattern !== undefined
          ? { publisherPattern: input.publisherPattern }
          : {}),
        ...(input.titlePattern !== undefined ? { titlePattern: input.titlePattern } : {}),
      },
    })
  );

  await logAudit({
    actorId,
    action: "datasource.update",
    targetType: "DataSource",
    targetId: ds.id,
    metadata: input as unknown as Record<string, unknown>,
  });

  return ds;
}

// ============================================================
// アイテム導出 (itemRule 別。SourceRecord/Asset から導出)
// ============================================================

export interface DerivedItem {
  itemKey: string; // url または "YYYY-MM-DD"
  itemDate: Date | null; // Date(UTC 00:00) or null
  itemTitle: string | null;
}

type DerivableSource = {
  id: string;
  itemRule: ItemRule;
  publisherPattern: string | null;
  titlePattern: string | null;
};

/**
 * `|` 区切りの複数 LIKE を OR で結合した条件を作る（v2.2）。空要素は無視。
 * 例: "A%|B%" → `(col LIKE 'A%' OR col LIKE 'B%')`。null/空/全要素空なら null。
 * colSql は固定のカラム参照フラグメント（Prisma.sql`sr.publisher` 等）を渡す。
 */
function likeOrSql(colSql: Prisma.Sql, pattern: string | null | undefined): Prisma.Sql | null {
  const parts = (pattern ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const ors = parts.map((p) => Prisma.sql`${colSql} LIKE ${p}`);
  return Prisma.sql`(${Prisma.join(ors, " OR ")})`;
}

/**
 * SourceRecord (別名 sr) の publisher/title に対するパターン条件を返す（`|` OR 対応）。
 * deriveItems と items エンリッチの両方で同じ絞り込みを共有するためエクスポートする。
 */
export function sourcePatternConds(ds: {
  publisherPattern: string | null;
  titlePattern: string | null;
}): Prisma.Sql[] {
  const out: Prisma.Sql[] = [];
  const p = likeOrSql(Prisma.sql`sr.publisher`, ds.publisherPattern);
  const t = likeOrSql(Prisma.sql`sr.title`, ds.titlePattern);
  if (p) out.push(p);
  if (t) out.push(t);
  return out;
}

/** トークの「JST 壁時計の日付」式（Asset 別名 a を前提）。deriveItems/エンリッチで共有。 */
export const TALK_DAY_SQL = Prisma.sql`(((a."canonicalDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Tokyo')::date)`;

/**
 * DataSource のアイテムを導出する（itemRule 別）。withClearance の tx 経由で呼ぶこと
 * （Asset/SourceRecord の RLS が効く）。返り値は itemDate 昇順（null は末尾）でソート済み。
 *
 * - blog_url / source_url: publisher/title パターンに一致する SourceRecord を url で distinct。
 *   itemDate = その url の Asset.canonicalDate(無ければ publishedAt) の min。itemTitle = 代表 title。
 * - talk_date: パターンに一致する Asset の canonicalDate を日単位で distinct。itemTitle = "トーク YYYY-MM-DD"。
 * - manual: 空リスト。
 *
 * opts.onlyKeys を渡すと導出を対象 itemKey に絞る（トグルのスナップショット取得用）。
 */
export async function deriveItems(
  tx: TransactionClient,
  ds: DerivableSource,
  opts: { onlyKeys?: string[] } = {}
): Promise<DerivedItem[]> {
  const { onlyKeys } = opts;
  if (ds.itemRule === "manual") return [];
  if (onlyKeys && onlyKeys.length === 0) return [];

  let rows: DerivedItem[];

  // 日付バケットは JST 基準。canonicalDate/publishedAt は「UTC 実時刻の naive timestamp」で
  // 保存されているため、素の ::date（=UTC日付）だと JST 0〜9時のデータが前日に落ちる
  // （実測: トーク26,794件中1,515件≒5.7%がずれる）。AT TIME ZONE で JST の壁時計に直してから date 化する。
  if (ds.itemRule === "talk_date") {
    const conds: Prisma.Sql[] = [Prisma.sql`a."canonicalDate" IS NOT NULL`, ...sourcePatternConds(ds)];
    if (onlyKeys)
      conds.push(
        Prisma.sql`(((a."canonicalDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Tokyo')::date)::text = ANY(${onlyKeys})`
      );
    rows = await tx.$queryRaw<DerivedItem[]>`
      SELECT (((a."canonicalDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Tokyo')::date)::text AS "itemKey",
             ((a."canonicalDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Tokyo')::date         AS "itemDate",
             NULL::text                                                                       AS "itemTitle"
      FROM "Asset" a
      JOIN "SourceRecord" sr ON sr."assetId" = a.id
      WHERE ${Prisma.join(conds, " AND ")}
      GROUP BY ((a."canonicalDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Tokyo')::date
    `;
    for (const r of rows) r.itemTitle = `トーク ${r.itemKey}`;
  } else {
    // blog_url / source_url — SourceRecord を url で distinct
    const conds: Prisma.Sql[] = [
      Prisma.sql`sr.url IS NOT NULL AND sr.url <> ''`,
      ...sourcePatternConds(ds),
    ];
    if (onlyKeys) conds.push(Prisma.sql`sr.url = ANY(${onlyKeys})`);
    rows = await tx.$queryRaw<DerivedItem[]>`
      SELECT sr.url                                                  AS "itemKey",
             ((MIN(COALESCE(a."canonicalDate", sr."publishedAt")) AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Tokyo')::date AS "itemDate",
             MAX(NULLIF(sr.title, ''))                               AS "itemTitle"
      FROM "SourceRecord" sr
      JOIN "Asset" a ON a.id = sr."assetId"
      WHERE ${Prisma.join(conds, " AND ")}
      GROUP BY sr.url
    `;
  }

  // itemDate 昇順（null は末尾）、tiebreak は itemKey 昇順
  rows.sort((a, b) => {
    if (a.itemDate && b.itemDate) {
      const d = a.itemDate.getTime() - b.itemDate.getTime();
      if (d !== 0) return d;
    } else if (a.itemDate && !b.itemDate) {
      return -1;
    } else if (!a.itemDate && b.itemDate) {
      return 1;
    }
    return a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0;
  });

  return rows;
}

export function itemRuleIsUrl(rule: ItemRule): boolean {
  return rule === "blog_url" || rule === "source_url";
}

// ============================================================
// 導出キャッシュ (getDerivedItems)
// ============================================================

/** unstable_cache は JSON シリアライズするため Date を文字列で保持する内部形。 */
interface SerializedDerivedItem {
  itemKey: string;
  itemDate: string | null; // YYYY-MM-DD
  itemTitle: string | null;
}

/** 自前の小さい withClearance tx で1ソース分だけ導出する（大きい tx に相乗りしない）。 */
async function computeDerivedItemsSerialized(
  sourceKey: string,
  clearance: string
): Promise<SerializedDerivedItem[]> {
  return withClearance(clearance, async (tx) => {
    const ds = await tx.dataSource.findUnique({ where: { key: sourceKey } });
    if (!ds) return [];
    const items = await deriveItems(tx, ds);
    return items.map((i) => ({
      itemKey: i.itemKey,
      itemDate: toDateOnlyString(i.itemDate),
      itemTitle: i.itemTitle,
    }));
  });
}

/**
 * ソースの導出アイテムをキャッシュ付きで返す（v2.2 P2028 対策）。
 *
 * ブログ導出（13.9k SourceRecord の集約）はローカル→Supabase のレイテンシ込みで
 * Prisma interactive tx の既定 5s を超えうるため、導出は**キャッシュ付きの独立した
 * 小さいトランザクション**で実行し、buildMatrix / listItems の tx には相乗りさせない。
 * チェック操作でアイテム集合は変わらないので invalidate は TTL（90秒）任せで十分。
 * key は source×clearance（RLS の見え方が clearance で変わるため）。
 */
export async function getDerivedItems(
  sourceKey: string,
  clearance: string
): Promise<DerivedItem[]> {
  const cached = unstable_cache(
    () => computeDerivedItemsSerialized(sourceKey, clearance),
    ["coverage-derived-items", sourceKey, clearance],
    { revalidate: 90, tags: ["coverage-derived-items"] }
  );
  const rows = await cached();
  // キャッシュ経由は JSON 化されるので Date に復元する
  return rows.map((r) => ({
    itemKey: r.itemKey,
    itemDate: parseDateOnly(r.itemDate),
    itemTitle: r.itemTitle,
  }));
}

/**
 * 「この日まで全部見た」と言える導出日付。
 * itemDate 昇順で見て、最古の未チェックの直前のアイテムの日付。
 * 未チェックが無ければ最新アイテムの日付。先頭から未チェックなら null。
 */
function computeContinuousUntil(
  items: DerivedItem[],
  checked: Set<string> | undefined
): Date | null {
  if (!checked || checked.size === 0) return null;
  let cur: Date | null = null;
  for (const item of items) {
    if (!item.itemDate) continue; // 日付なしアイテムはカーソルに影響させない
    if (checked.has(item.itemKey)) cur = item.itemDate;
    else break;
  }
  return cur;
}

// ============================================================
// マトリクス (導出値入りセル)
// ============================================================

export interface CoverageLensDTO {
  id: string;
  key: string;
  name: string;
  description: string;
  sortOrder: number;
  active: boolean;
  public: boolean;
  classification: ClearanceLevel;
}

export interface CoverageDataSourceDTO {
  id: string;
  key: string;
  name: string;
  kind: DataSourceKind;
  description: string | null;
  sortOrder: number;
  active: boolean;
  public: boolean;
  classification: ClearanceLevel;
  itemRule: ItemRule;
  publisherPattern: string | null;
  titlePattern: string | null;
  totalItems: number; // 導出アイテム総数（lens に依らずソース共通）
}

export interface CoverageCellDTO {
  lensId: string;
  dataSourceId: string;
  lensKey: string;
  dataSourceKey: string;
  status: CoverageStatus; // Coverage 行が無ければ tracked
  note: string | null; // 内部メモ（publicOnly では null）
  totalItems: number;
  checkedItems: number;
  continuousUntil: string | null; // YYYY-MM-DD
  lastCheckedAt: string | null; // ISO
}

export interface CoverageMatrixDTO {
  lenses: CoverageLensDTO[];
  dataSources: CoverageDataSourceDTO[];
  cells: CoverageCellDTO[];
}

interface BuiltMatrix {
  lenses: Awaited<ReturnType<TransactionClient["lens"]["findMany"]>>;
  dataSources: Awaited<ReturnType<TransactionClient["dataSource"]["findMany"]>>;
  derivedBySource: Map<string, DerivedItem[]>;
  cells: CoverageCellDTO[];
}

/**
 * lens / dataSource / 導出アイテム / チェックを N+1 無しで集めてセル導出値を組む。
 * 導出は「ソース別に1回」（≤ ソース数）、チェックは「全体1回」の集約。
 * セル単位のクエリは発行しない（設計書 §4）。
 *
 * P2028 対策: 以前は全ソースの導出を1つの withClearance tx 内で直列実行しており、
 * ブログ導出だけで interactive tx の既定 5s を超えることがあった。現在は
 * 「メタ＋チェック集計」だけを小さい tx で取り、導出はソースごとに
 * getDerivedItems（キャッシュ付き独立トランザクション）を並列で呼ぶ。
 */
async function buildMatrix(
  clearance: string,
  options: { publicOnly?: boolean } = {}
): Promise<BuiltMatrix> {
  const { publicOnly = false } = options;

  // 1) メタ＋チェック集計（速いクエリのみの小さい tx）
  const { lenses, dataSources, coverages, checks } = await withClearance(
    clearance,
    async (tx) => {
      const [lenses, dataSources, coverages] = await Promise.all([
        tx.lens.findMany({
          where: publicOnly ? { public: true, active: true } : {},
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        }),
        tx.dataSource.findMany({
          where: publicOnly ? { public: true, active: true } : {},
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        }),
        tx.coverage.findMany({
          include: { lens: { select: { key: true } }, dataSource: { select: { key: true } } },
        }),
      ]);

      // チェックは全体1回。(lensId:dataSourceId) 別に itemKey 集合＋最終チェック時刻を集約。
      const lensIds = lenses.map((l) => l.id);
      const dsIds = dataSources.map((d) => d.id);
      const checks =
        lensIds.length && dsIds.length
          ? await tx.lensItemCheck.findMany({
              where: { lensId: { in: lensIds }, dataSourceId: { in: dsIds } },
              select: { lensId: true, dataSourceId: true, itemKey: true, checkedAt: true },
            })
          : [];

      return { lenses, dataSources, coverages, checks };
    }
  );

  // 2) ソース別にアイテム導出（各ソース = キャッシュ付き独立 tx。並列）
  const derivedLists = await Promise.all(
    dataSources.map((ds) => getDerivedItems(ds.key, clearance))
  );
  const derivedBySource = new Map<string, DerivedItem[]>();
  dataSources.forEach((ds, i) => derivedBySource.set(ds.id, derivedLists[i]));

  const checkMap = new Map<string, { keys: Set<string>; last: Date | null }>();
  for (const c of checks) {
    const k = `${c.lensId}:${c.dataSourceId}`;
    let g = checkMap.get(k);
    if (!g) {
      g = { keys: new Set(), last: null };
      checkMap.set(k, g);
    }
    g.keys.add(c.itemKey);
    if (!g.last || c.checkedAt > g.last) g.last = c.checkedAt;
  }

  const covMap = new Map<string, (typeof coverages)[number]>();
  for (const c of coverages) covMap.set(`${c.lensId}:${c.dataSourceId}`, c);

  const cells: CoverageCellDTO[] = [];
  for (const lens of lenses) {
    for (const ds of dataSources) {
      const derived = derivedBySource.get(ds.id) ?? [];
      const g = checkMap.get(`${lens.id}:${ds.id}`);
      const checkedKeys = g?.keys;
      // 導出アイテムと itemKey が一致するチェックのみ数える
      const checkedItems = checkedKeys
        ? derived.reduce((n, d) => (checkedKeys.has(d.itemKey) ? n + 1 : n), 0)
        : 0;
      const continuousUntil = computeContinuousUntil(derived, checkedKeys);
      const cov = covMap.get(`${lens.id}:${ds.id}`);
      cells.push({
        lensId: lens.id,
        dataSourceId: ds.id,
        lensKey: lens.key,
        dataSourceKey: ds.key,
        status: cov?.status ?? "tracked",
        note: publicOnly ? null : cov?.note ?? null,
        totalItems: derived.length,
        checkedItems,
        continuousUntil: toDateOnlyString(continuousUntil),
        lastCheckedAt: g?.last ? g.last.toISOString() : null,
      });
    }
  }

  return { lenses, dataSources, derivedBySource, cells };
}

/**
 * マトリクス全体を取得する（導出値入りセル）。
 * options.publicOnly=true のとき public な Lens×DataSource のみ・cell の note を除去。
 */
export async function getMatrix(
  clearance: string,
  options: { publicOnly?: boolean } = {}
): Promise<CoverageMatrixDTO> {
  const built = await buildMatrix(clearance, options);
  const totalBySource = new Map<string, number>();
  for (const [dsId, items] of built.derivedBySource) totalBySource.set(dsId, items.length);

  return {
    lenses: built.lenses.map((l) => ({
      id: l.id,
      key: l.key,
      name: l.name,
      description: l.description,
      sortOrder: l.sortOrder,
      active: l.active,
      public: l.public,
      classification: l.classification,
    })),
    dataSources: built.dataSources.map((d) => ({
      id: d.id,
      key: d.key,
      name: d.name,
      kind: d.kind,
      description: d.description,
      sortOrder: d.sortOrder,
      active: d.active,
      public: d.public,
      classification: d.classification,
      itemRule: d.itemRule,
      publisherPattern: d.publisherPattern,
      titlePattern: d.titlePattern,
      totalItems: totalBySource.get(d.id) ?? 0,
    })),
    cells: built.cells,
  };
}

// ============================================================
// セル注記 (not_applicable / note 専用に縮退)
// ============================================================

export interface UpsertCellInput {
  lensKey: string;
  dataSourceKey: string;
  status?: CoverageStatus;
  note?: string | null;
  classification?: ClearanceLevel;
}

export interface CoverageCellNoteDTO {
  id: string;
  lensKey: string;
  dataSourceKey: string;
  status: CoverageStatus;
  note: string | null;
  classification: ClearanceLevel;
  updatedAt: string;
}

/**
 * セル注記を upsert する（lensKey + dataSourceKey で特定）。
 * v2 では日付カーソルを廃止し、status=not_applicable（対象外マーク）と note のみを扱う。
 */
export async function upsertCell(
  input: UpsertCellInput,
  clearance: string,
  actorId?: string | null
): Promise<CoverageCellNoteDTO> {
  const status: CoverageStatus = input.status ?? "tracked";

  const cell = await withClearance(clearance, async (tx) => {
    const lens = await tx.lens.findUnique({ where: { key: input.lensKey } });
    if (!lens) throw new Error(`Lens not found: ${input.lensKey}`);
    const dataSource = await tx.dataSource.findUnique({
      where: { key: input.dataSourceKey },
    });
    if (!dataSource) throw new Error(`DataSource not found: ${input.dataSourceKey}`);

    return tx.coverage.upsert({
      where: {
        lensId_dataSourceId: { lensId: lens.id, dataSourceId: dataSource.id },
      },
      create: {
        lensId: lens.id,
        dataSourceId: dataSource.id,
        status,
        note: input.note ?? null,
        classification: input.classification ?? "internal",
        updatedById: actorId ?? null,
      },
      update: {
        status,
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.classification !== undefined
          ? { classification: input.classification }
          : {}),
        updatedById: actorId ?? null,
      },
      include: {
        lens: { select: { key: true } },
        dataSource: { select: { key: true } },
      },
    });
  });

  await logAudit({
    actorId,
    action: "coverage.update",
    targetType: "Coverage",
    targetId: cell.id,
    metadata: {
      lensKey: input.lensKey,
      dataSourceKey: input.dataSourceKey,
      status,
    },
  });

  return {
    id: cell.id,
    lensKey: cell.lens.key,
    dataSourceKey: cell.dataSource.key,
    status: cell.status,
    note: cell.note,
    classification: cell.classification,
    updatedAt: cell.updatedAt.toISOString(),
  };
}

// ============================================================
// アイテム一覧 (listItems) — トリアージ UX のエンリッチを含むため coverage-items.ts に分離。
// 公開インポート面は @/lib/domain/coverage のまま維持する（後方互換の再エクスポート）。
// ============================================================

export { listItems } from "./coverage-items";
export type { ItemDTO, ListItemsResult, ListItemsOptions } from "./coverage-items";

// ============================================================
// チェックのトグル / 範囲一括
// ============================================================

export interface ToggleCheckInput {
  lensKey: string;
  dataSourceKey: string;
  itemKey: string;
  checked: boolean;
  note?: string | null;
  classification?: ClearanceLevel;
}

export interface ToggleCheckResult {
  checked: boolean;
  lensKey: string;
  dataSourceKey: string;
  itemKey: string;
}

/**
 * アイテムチェックをトグルする（冪等）。
 * checked=true: LensItemCheck を upsert（itemDate/itemTitle は導出値のスナップショットを保存）。
 *   導出に無い itemKey はエラー（不正なチェック防止）。
 * checked=false: 削除（無ければ何もしない）。
 */
export async function toggleCheck(
  input: ToggleCheckInput,
  clearance: string,
  actorId?: string | null
): Promise<ToggleCheckResult> {
  const result = await withClearance(clearance, async (tx) => {
    const lens = await tx.lens.findUnique({ where: { key: input.lensKey } });
    if (!lens) throw new Error(`Lens not found: ${input.lensKey}`);
    const ds = await tx.dataSource.findUnique({ where: { key: input.dataSourceKey } });
    if (!ds) throw new Error(`DataSource not found: ${input.dataSourceKey}`);

    if (input.checked) {
      const [item] = await deriveItems(tx, ds, { onlyKeys: [input.itemKey] });
      if (!item) throw new Error(`Item not found in source ${input.dataSourceKey}: ${input.itemKey}`);
      const rec = await tx.lensItemCheck.upsert({
        where: {
          lensId_dataSourceId_itemKey: {
            lensId: lens.id,
            dataSourceId: ds.id,
            itemKey: input.itemKey,
          },
        },
        create: {
          lensId: lens.id,
          dataSourceId: ds.id,
          itemKey: input.itemKey,
          itemDate: item.itemDate,
          itemTitle: item.itemTitle,
          note: input.note ?? null,
          classification: input.classification ?? "internal",
          checkedById: actorId ?? null,
        },
        update: {
          // スナップショットを最新の導出値に追従（冪等）
          itemDate: item.itemDate,
          itemTitle: item.itemTitle,
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(input.classification !== undefined
            ? { classification: input.classification }
            : {}),
        },
      });
      return { recId: rec.id, checked: true, lensId: lens.id, dsId: ds.id };
    } else {
      await tx.lensItemCheck.deleteMany({
        where: { lensId: lens.id, dataSourceId: ds.id, itemKey: input.itemKey },
      });
      return { recId: null, checked: false, lensId: lens.id, dsId: ds.id };
    }
  });

  await logAudit({
    actorId,
    action: "coverage.check",
    targetType: "LensItemCheck",
    targetId: result.recId ?? `${result.lensId}:${result.dsId}:${input.itemKey}`,
    metadata: {
      lensKey: input.lensKey,
      dataSourceKey: input.dataSourceKey,
      itemKey: input.itemKey,
      checked: input.checked,
    },
  });

  return {
    checked: result.checked,
    lensKey: input.lensKey,
    dataSourceKey: input.dataSourceKey,
    itemKey: input.itemKey,
  };
}

export interface BulkCheckInput {
  dataSourceKey: string;
  lensKeys: string[];
  untilDate: string; // YYYY-MM-DD（この日以前の導出アイテムを対象）
  onlyMentionless?: boolean; // true: 坂井新奈への言及なしのアイテムだけを対象にする
  classification?: ClearanceLevel;
}

export interface BulkCheckResult {
  created: number; // 実際に作成された LensItemCheck 行数（既存はスキップ）
  targetItems: number; // untilDate 以前（onlyMentionless 時は言及なしに限定）の導出アイテム数
  lensKeys: string[];
}

/**
 * 範囲一括チェック。untilDate 以前（itemDate <= untilDate）の全導出アイテムを、
 * 対象 lens すべてに createMany skipDuplicates でチェック済みにする。
 * onlyMentionless=true のときは、さらに坂井新奈への言及がないアイテムだけに絞る
 * （「言及なしをここまで一括✓」= 退屈な9割を一掃する省力化）。言及集合はソース全体で
 * 導出する（getSourceMentionKeys・数分キャッシュ）。url 系ソースのみ有効（talk は全件本人）。
 */
export async function bulkCheck(
  input: BulkCheckInput,
  clearance: string,
  actorId?: string | null
): Promise<BulkCheckResult> {
  const until = parseDateOnly(input.untilDate);
  if (!until) throw new Error("untilDate is required (YYYY-MM-DD)");
  if (!input.lensKeys || input.lensKeys.length === 0) {
    throw new Error("lensKeys is required");
  }

  // 言及なし絞り込み用のソース全体の言及ありキー集合（url 系のみ非空）。
  const mentionKeys = input.onlyMentionless
    ? new Set(await getSourceMentionKeys(input.dataSourceKey, clearance))
    : null;

  const result = await withClearance(clearance, async (tx) => {
    const ds = await tx.dataSource.findUnique({ where: { key: input.dataSourceKey } });
    if (!ds) throw new Error(`DataSource not found: ${input.dataSourceKey}`);
    const lenses = await tx.lens.findMany({ where: { key: { in: input.lensKeys } } });
    if (lenses.length !== new Set(input.lensKeys).size) {
      throw new Error("Unknown lensKey in lensKeys");
    }

    const derived = await deriveItems(tx, ds);
    let targets = derived.filter((d) => d.itemDate && d.itemDate <= until);
    if (mentionKeys) targets = targets.filter((d) => !mentionKeys.has(d.itemKey));

    let created = 0;
    if (targets.length > 0) {
      for (const lens of lenses) {
        const res = await tx.lensItemCheck.createMany({
          data: targets.map((t) => ({
            lensId: lens.id,
            dataSourceId: ds.id,
            itemKey: t.itemKey,
            itemDate: t.itemDate,
            itemTitle: t.itemTitle,
            classification: input.classification ?? "internal",
            checkedById: actorId ?? null,
          })),
          skipDuplicates: true,
        });
        created += res.count;
      }
    }
    return { created, targetItems: targets.length };
  });

  await logAudit({
    actorId,
    action: "coverage.bulk_check",
    targetType: "DataSource",
    targetId: input.dataSourceKey,
    metadata: {
      dataSourceKey: input.dataSourceKey,
      lensKeys: input.lensKeys,
      untilDate: input.untilDate,
      onlyMentionless: input.onlyMentionless ?? false,
      created: result.created,
      targetItems: result.targetItems,
    },
  });

  return { created: result.created, targetItems: result.targetItems, lensKeys: input.lensKeys };
}

// ============================================================
// Summary (サイト公開用の要約) — v2
// ============================================================

export interface CoverageSummaryDTO {
  generatedAt: string;
  lenses: {
    key: string;
    name: string;
    sources: {
      key: string;
      name: string;
      continuousUntil: string | null; // YYYY-MM-DD
      checked: number;
      total: number;
    }[];
    minContinuousUntil: string | null;
  }[];
}

/**
 * サイト公開用の要約を生成する（v2）。
 * - public な Lens × public な DataSource のみ（いずれも active）
 * - 導出アイテムのあるソース（total > 0）かつ not_applicable でないセルのみ
 * - note は含めない
 * - minContinuousUntil = その観点で最も遅れているソースの continuousUntil
 *   （どれか1つでも先頭から未チェック=null なら null）
 * - 対象ソースが1つも無い Lens は含めない
 */
export async function getSummary(clearance: string): Promise<CoverageSummaryDTO> {
  const built = await buildMatrix(clearance, { publicOnly: true });

  const dsById = new Map(built.dataSources.map((d) => [d.id, d]));
  const cellsByLens = new Map<string, CoverageCellDTO[]>();
  for (const cell of built.cells) {
    const arr = cellsByLens.get(cell.lensId) ?? [];
    arr.push(cell);
    cellsByLens.set(cell.lensId, arr);
  }

  const resultLenses = built.lenses
    .map((l) => {
      const cells = (cellsByLens.get(l.id) ?? []).filter(
        (c) => c.status !== "not_applicable" && c.totalItems > 0
      );
      if (cells.length === 0) return null;

      const sources = cells
        .map((c) => {
          const ds = dsById.get(c.dataSourceId)!;
          return {
            key: c.dataSourceKey,
            name: ds.name,
            sortOrder: ds.sortOrder,
            continuousUntil: c.continuousUntil,
            checked: c.checkedItems,
            total: c.totalItems,
          };
        })
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

      // 最も遅れているソース: null があれば null、無ければ最小の日付
      let minContinuousUntil: string | null = sources[0].continuousUntil;
      for (const s of sources) {
        if (s.continuousUntil === null) {
          minContinuousUntil = null;
          break;
        }
        if (minContinuousUntil !== null && s.continuousUntil < minContinuousUntil) {
          minContinuousUntil = s.continuousUntil;
        }
      }

      return {
        key: l.key,
        name: l.name,
        sources: sources.map((s) => ({
          key: s.key,
          name: s.name,
          continuousUntil: s.continuousUntil,
          checked: s.checked,
          total: s.total,
        })),
        minContinuousUntil,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return {
    generatedAt: new Date().toISOString(),
    lenses: resultLenses,
  };
}
