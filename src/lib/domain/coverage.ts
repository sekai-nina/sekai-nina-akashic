/**
 * 公開鮮度の管理と素材の導出。鮮度は観点×ソースの日付を直接保存する（#233 段階3）。
 * 未編集セルだけ旧チェックから日付を読み取り導出し、旧記録への書き込みは行わない。
 * 素材導出は /progress でも利用する。保護テーブルは withClearance 経由。
 */

import { ClearanceLevel, CoverageStatus, DataSourceKind, ItemRule, Prisma } from "@prisma/client";
import { unstable_cache } from "next/cache";
import { withClearance, type TransactionClient } from "@/lib/db";
import { logAudit } from "./audit";
import { assertClearance, isAboveClearance } from "@/lib/classification";
import { legacyConfirmedUntil, parseConfirmedUntil, CoverageInputError, CoveragePermissionError } from "@/lib/coverage/freshness";
import { z } from "zod";

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

/**
 * 導出 tx のタイムアウト。温まっていればトークでも ~1s だが、本番で Postgres の
 * キャッシュが冷えていると 22s かかって既定 15s の P2028 になった（2026-09-23）。
 */
const DERIVE_TX_TIMEOUT_MS = 30_000;

/** 自前の小さい withClearance tx で1ソース分だけ導出する（大きい tx に相乗りしない）。 */
async function computeDerivedItemsSerialized(
  sourceKey: string,
  clearance: string
): Promise<SerializedDerivedItem[]> {
  return withClearance(
    clearance,
    async (tx) => {
      const ds = await tx.dataSource.findUnique({ where: { key: sourceKey } });
      if (!ds) return [];
      const items = await deriveItems(tx, ds);
      return items.map((i) => ({
        itemKey: i.itemKey,
        itemDate: toDateOnlyString(i.itemDate),
        itemTitle: i.itemTitle,
      }));
    },
    { timeout: DERIVE_TX_TIMEOUT_MS }
  );
}

/**
 * ソースの導出アイテムをキャッシュ付きで返す（v2.2 P2028 対策）。
 *
 * ブログ・トーク導出は重い集約で、Postgres のキャッシュが冷えていると withClearance の
 * 既定 15s を超えうるため、導出は**キャッシュ付きの独立した小さいトランザクション**
 * （タイムアウト DERIVE_TX_TIMEOUT_MS）で実行し、buildMatrix / listItems の tx には相乗りさせない。
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
}

export interface CoverageCellDTO {
  lensId: string;
  dataSourceId: string;
  lensKey: string;
  dataSourceKey: string;
  status: CoverageStatus; // Coverage 行が無ければ tracked
  note: string | null; // 内部メモ（publicOnly では null）
  continuousUntil: string | null; // 確認済み日付（YYYY-MM-DD）。既存の公開キー名を維持
  dateOrigin: "manual" | "legacy" | null;
  freshnessUpdatedAt: string | null; // 明示設定日時。日付を空に戻した場合も記録する
}

export interface CoverageMatrixDTO {
  lenses: CoverageLensDTO[];
  dataSources: CoverageDataSourceDTO[];
  cells: CoverageCellDTO[];
}

/** ソース導出の同時実行を接続プールの一部に制限する。 */
const DERIVE_CONCURRENCY = 3;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** 公開鮮度マトリクス。publicOnly は公開・有効な行列だけを返し、内部メモを除く。 */
export async function getMatrix(
  clearance: string,
  options: { publicOnly?: boolean } = {}
): Promise<CoverageMatrixDTO> {
  const { publicOnly = false } = options;
  const { lenses, dataSources, coverages, checks } = await withClearance(clearance, async (tx) => {
    const [lenses, dataSources, coverages] = await Promise.all([
      tx.lens.findMany({
        where: publicOnly ? { public: true, active: true } : {},
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      tx.dataSource.findMany({
        where: publicOnly ? { public: true, active: true } : {},
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      tx.coverage.findMany(),
    ]);
    const cells = new Map(coverages.map((c) => [JSON.stringify([c.lensId, c.dataSourceId]), c]));
    // 明示設定していない組だけ旧記録を読む。手動入力済みセルは旧チェックに戻らない。
    const legacyPairs = lenses.flatMap((l) => dataSources.flatMap((d) => {
      const cell = cells.get(JSON.stringify([l.id, d.id]));
      return d.itemRule !== "manual" && !cell?.freshnessUpdatedAt && cell?.status !== "not_applicable"
        ? [{ lensId: l.id, dataSourceId: d.id }] : [];
    }));
    const checks = legacyPairs.length ? await tx.lensItemCheck.findMany({
      where: { OR: legacyPairs },
      select: { lensId: true, dataSourceId: true, itemKey: true },
    }) : [];
    return { lenses, dataSources, coverages, checks };
  });

  const checkMap = new Map<string, Set<string>>();
  for (const check of checks) {
    const key = JSON.stringify([check.lensId, check.dataSourceId]);
    const keys = checkMap.get(key) ?? new Set<string>();
    keys.add(check.itemKey);
    checkMap.set(key, keys);
  }
  // 旧チェックが存在する未編集ソースだけ導出する。全セル入力後は素材の全件導出が不要。
  const legacySourceIds = new Set(checks.map((c) => c.dataSourceId));
  const legacySources = dataSources.filter((d) => legacySourceIds.has(d.id));
  const lists = await mapWithConcurrency(legacySources, DERIVE_CONCURRENCY, (d) => getDerivedItems(d.key, clearance));
  const derived = new Map(legacySources.map((d, i) => [d.id, lists[i]]));
  const covMap = new Map(coverages.map((c) => [JSON.stringify([c.lensId, c.dataSourceId]), c]));
  const cells = lenses.flatMap((lens) => dataSources.map((ds): CoverageCellDTO => {
    const key = JSON.stringify([lens.id, ds.id]);
    const cov = covMap.get(key);
    const manual = cov?.freshnessUpdatedAt != null;
    const keys = checkMap.get(key);
    return {
      lensId: lens.id, dataSourceId: ds.id, lensKey: lens.key, dataSourceKey: ds.key,
      status: cov?.status ?? "tracked", note: publicOnly ? null : cov?.note ?? null,
      continuousUntil: manual ? toDateOnlyString(cov.confirmedUntil)
        : legacyConfirmedUntil(derived.get(ds.id) ?? [], keys),
      dateOrigin: manual ? "manual" : keys?.size ? "legacy" : null,
      freshnessUpdatedAt: cov?.freshnessUpdatedAt?.toISOString() ?? null,
    };
  }));
  return {
    lenses: lenses.map(({ id, key, name, description, sortOrder, active, public: isPublic, classification }) =>
      ({ id, key, name, description, sortOrder, active, public: isPublic, classification })),
    dataSources: dataSources.map(({ id, key, name, kind, description, sortOrder, active, public: isPublic, classification, itemRule, publisherPattern, titlePattern }) =>
      ({ id, key, name, kind, description, sortOrder, active, public: isPublic, classification, itemRule, publisherPattern, titlePattern })),
    cells,
  };
}

// ============================================================
// 鮮度日付 / 対象外 / 内部メモ
// ============================================================

export interface UpsertCellInput {
  lensKey: string;
  dataSourceKey: string;
  status?: CoverageStatus;
  confirmedUntil?: string | null;
  note?: string | null;
  classification?: ClearanceLevel;
}

export interface CoverageCellNoteDTO {
  confirmedUntil: string | null;
  freshnessUpdatedAt: string | null;
  id: string;
  lensKey: string;
  dataSourceKey: string;
  status: CoverageStatus;
  note: string | null;
  classification: ClearanceLevel;
  updatedAt: string;
}

const cellInputSchema = z.object({
  lensKey: z.string().min(1).max(128),
  dataSourceKey: z.string().min(1).max(128),
  status: z.enum(["tracked", "not_applicable"]).optional(),
  confirmedUntil: z.string().nullable().optional(),
  note: z.string().max(10000).nullable().optional(),
  classification: z.nativeEnum(ClearanceLevel).optional(),
});

/** 日付の省略は保持、null は明示的な未確認。既存の機密を下げずに保存する。 */
export async function upsertCell(
  input: UpsertCellInput,
  clearance: string,
  actorId?: string | null
): Promise<CoverageCellNoteDTO> {
  const parsed = cellInputSchema.safeParse(input);
  if (!parsed.success) throw new CoverageInputError("確認済み日付・状態・メモの入力を確認してください");
  const value = parsed.data;
  const confirmedUntil = value.confirmedUntil === undefined ? undefined : parseConfirmedUntil(value.confirmedUntil);
  if (value.classification) assertClearance(clearance, value.classification);
  const cell = await withClearance(clearance, async (tx) => {
    const lens = await tx.lens.findUnique({ where: { key: value.lensKey } });
    const dataSource = await tx.dataSource.findUnique({ where: { key: value.dataSourceKey } });
    if (!lens || !dataSource) throw new CoverageInputError("観点またはデータソースが見つかりません");
    // 行のない初回保存も直列化し、既存 classification の読み取りと書き込みを一体にする。
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["coverage", lens.id, dataSource.id])}, 0))`;
    const where = { lensId_dataSourceId: { lensId: lens.id, dataSourceId: dataSource.id } };
    const existing = await tx.coverage.findUnique({ where });
    let classification = value.classification ?? existing?.classification ?? "internal";
    for (const level of [lens.classification, dataSource.classification, existing?.classification]) {
      if (level && isAboveClearance(level, classification)) classification = level;
    }
    assertClearance(clearance, classification);
    const dateChange = confirmedUntil === undefined ? {} : { confirmedUntil, freshnessUpdatedAt: new Date() };
    return tx.coverage.upsert({
      where,
      create: {
        lensId: lens.id, dataSourceId: dataSource.id, status: value.status ?? "tracked",
        note: value.note ?? null, classification, updatedById: actorId ?? null, ...dateChange,
      },
      update: {
        ...(value.status !== undefined ? { status: value.status } : {}),
        ...(value.note !== undefined ? { note: value.note } : {}),
        classification, updatedById: actorId ?? null, ...dateChange,
      },
      include: { lens: { select: { key: true } }, dataSource: { select: { key: true } } },
    });
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2004", "P2025"].includes(error.code)
      || error instanceof Error && /row-level security/i.test(error.message)) {
      throw new CoveragePermissionError("現在の閲覧範囲では、この鮮度日付を更新できません");
    }
    throw error;
  });
  await logAudit({
    actorId, action: "coverage.update", targetType: "Coverage", targetId: cell.id,
    metadata: { lensKey: value.lensKey, dataSourceKey: value.dataSourceKey, status: cell.status,
      ...(confirmedUntil !== undefined ? { confirmedUntil: toDateOnlyString(confirmedUntil) } : {}) },
  });
  return {
    id: cell.id, lensKey: cell.lens.key, dataSourceKey: cell.dataSource.key,
    status: cell.status, note: cell.note, classification: cell.classification,
    confirmedUntil: toDateOnlyString(cell.confirmedUntil),
    freshnessUpdatedAt: cell.freshnessUpdatedAt?.toISOString() ?? null, updatedAt: cell.updatedAt.toISOString(),
  };
}

// ============================================================
// アイテム一覧 (listItems) — トリアージ UX のエンリッチを含むため coverage-items.ts に分離。
// 公開インポート面は @/lib/domain/coverage のまま維持する（後方互換の再エクスポート）。
// ============================================================

export { listItems } from "./coverage-items";
export type { ItemDTO, ListItemsResult, ListItemsOptions } from "./coverage-items";

// ============================================================
// Summary (サイト公開用の鮮度日付)
// ============================================================

export interface CoverageSummaryDTO {
  generatedAt: string;
  lenses: {
    key: string;
    name: string;
    sources: { key: string; name: string; continuousUntil: string | null }[];
    minContinuousUntil: string | null;
  }[];
}

/** 公開・有効な観点×ソースの確認済み日付。内部メモ・旧チェック件数は公開しない。 */
export async function getSummary(clearance: string): Promise<CoverageSummaryDTO> {
  const matrix = await getMatrix(clearance, { publicOnly: true });
  const cells = new Map(matrix.cells.map((c) => [JSON.stringify([c.lensId, c.dataSourceId]), c]));
  return {
    generatedAt: new Date().toISOString(),
    lenses: matrix.lenses.flatMap((lens) => {
      const sources = matrix.dataSources.flatMap((ds) => {
        const cell = cells.get(JSON.stringify([lens.id, ds.id]));
        return cell?.status === "not_applicable" ? [] : [{
          key: ds.key, name: ds.name, continuousUntil: cell?.continuousUntil ?? null,
        }];
      });
      if (!sources.length) return [];
      const dates = sources.map((s) => s.continuousUntil);
      return [{ key: lens.key, name: lens.name, sources,
        minContinuousUntil: dates.some((d) => d === null) ? null : (dates as string[]).sort()[0],
      }];
    }),
  };
}
