/**
 * 収集の管理（ソースごとの収集済みの日付・#253）と、データソースの素材導出。
 * 素材導出は /progress でも利用する。保護テーブルは withClearance 経由。
 *
 * 観点（Lens）× ソースの確認済み日付と観点ごとのチェック（#233）は #253 でやめた。
 * Lens / Coverage / LensItemCheck のテーブルと行は残すが、読み書きするコードは無い。
 */

import { ClearanceLevel, DataSourceKind, ItemRule, Prisma } from "@prisma/client";
import { unstable_cache } from "next/cache";
import { withClearance, type TransactionClient } from "@/lib/db";
import { logAudit } from "./audit";
import {
  autoCollectedUntil,
  CoverageInputError,
  CoveragePermissionError,
  heartbeatJobKey,
  parseCollectedUntil,
} from "@/lib/coverage/collection";

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
// 収集済みの日付（ソースごと・#253）
// ============================================================

export interface CollectionSourceDTO {
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
  /** 収集済みの日付（YYYY-MM-DD・JST）。null は未確認 */
  collectedUntil: string | null;
  /** bot のハートビートで出すソース。null なら手入力 */
  auto: { jobKey: string; jobName: string | null; lastOkAt: string | null; lastStatus: "ok" | "error" | null } | null;
  /** 手入力のソースの最終設定。auto のソースでは null */
  manual: { updatedAt: string | null; updatedByName: string | null } | null;
}

/**
 * ソースごとの収集済みの日付。publicOnly は公開・有効なソースだけを返す。
 * Job / User は非保護テーブルなので同じ tx で読んでよい。
 */
export async function getCollectionStatus(
  clearance: string,
  options: { publicOnly?: boolean } = {}
): Promise<CollectionSourceDTO[]> {
  const { publicOnly = false } = options;
  return withClearance(clearance, async (tx) => {
    const sources = await tx.dataSource.findMany({
      where: publicOnly ? { public: true, active: true } : {},
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    const jobKeys = [...new Set(sources.flatMap((s) => heartbeatJobKey(s.key) ?? []))];
    const userIds = [...new Set(sources.flatMap((s) => s.collectedUntilUpdatedById ?? []))];
    const [jobs, users] = await Promise.all([
      jobKeys.length
        ? tx.job.findMany({ where: { key: { in: jobKeys } }, select: { key: true, name: true, lastOkAt: true, lastStatus: true } })
        : [],
      userIds.length && !publicOnly
        ? tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
        : [],
    ]);
    const jobByKey = new Map(jobs.map((j) => [j.key, j]));
    const userName = new Map(users.map((u) => [u.id, u.name]));
    return sources.map((s): CollectionSourceDTO => {
      const jobKey = heartbeatJobKey(s.key);
      const job = jobKey ? jobByKey.get(jobKey) ?? null : null;
      return {
        id: s.id, key: s.key, name: s.name, kind: s.kind, description: s.description, sortOrder: s.sortOrder,
        active: s.active, public: s.public, classification: s.classification, itemRule: s.itemRule,
        publisherPattern: s.publisherPattern, titlePattern: s.titlePattern,
        collectedUntil: jobKey ? autoCollectedUntil(job?.lastOkAt) : toDateOnlyString(s.collectedUntil),
        auto: jobKey ? {
          jobKey,
          // 報告側が name を省くと Job.name は key になる
          jobName: job && job.name !== job.key ? job.name : null,
          lastOkAt: job?.lastOkAt?.toISOString() ?? null,
          lastStatus: job?.lastStatus ?? null,
        } : null,
        manual: jobKey ? null : {
          updatedAt: s.collectedUntilUpdatedAt?.toISOString() ?? null,
          updatedByName: s.collectedUntilUpdatedById ? userName.get(s.collectedUntilUpdatedById) ?? null : null,
        },
      };
    });
  });
}

export interface SourceItemStats {
  count: number;
  latestDate: string | null;
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

/** 最新の取り込み日と件数（/coverage の参考表示）。導出はキャッシュ付きの getDerivedItems を使う。 */
export async function getSourceItemStats(
  sources: { key: string; itemRule: ItemRule }[],
  clearance: string
): Promise<Map<string, SourceItemStats>> {
  const derivable = sources.filter((s) => s.itemRule !== "manual");
  const lists = await mapWithConcurrency(derivable, DERIVE_CONCURRENCY, (s) => getDerivedItems(s.key, clearance));
  return new Map(derivable.map((s, i) => {
    let latest: Date | null = null;
    for (const item of lists[i]) if (item.itemDate && (!latest || item.itemDate > latest)) latest = item.itemDate;
    return [s.key, { count: lists[i].length, latestDate: toDateOnlyString(latest) }];
  }));
}

/**
 * 手入力の収集済みの日付を設定する。null は未確認に戻す。
 * ハートビートで出すソースは手入力できない。見えないソース（RLS）は見つからない扱い。
 */
export async function setCollectedUntil(
  dataSourceKey: string,
  value: string | null,
  clearance: string,
  actorId?: string | null
) {
  if (heartbeatJobKey(dataSourceKey)) {
    throw new CoverageInputError("このソースは bot の稼働記録から自動で出すため、手では入力できません");
  }
  const collectedUntil = parseCollectedUntil(value);
  const ds = await withClearance(clearance, async (tx) => {
    const found = await tx.dataSource.findUnique({ where: { key: dataSourceKey }, select: { id: true } });
    if (!found) throw new CoverageInputError("データソースが見つかりません");
    return tx.dataSource.update({
      where: { id: found.id },
      data: { collectedUntil, collectedUntilUpdatedAt: new Date(), collectedUntilUpdatedById: actorId ?? null },
    });
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2004", "P2025"].includes(error.code)
      || error instanceof Error && /row-level security/i.test(error.message)) {
      throw new CoveragePermissionError("現在の閲覧範囲では、このソースの収集済みの日付を更新できません");
    }
    throw error;
  });
  await logAudit({
    actorId, action: "datasource.collected_until", targetType: "DataSource", targetId: ds.id,
    metadata: { key: ds.key, collectedUntil: toDateOnlyString(ds.collectedUntil) },
  });
  return ds;
}

// ============================================================
// Summary（公開サイトの /status 用）
// ============================================================

export interface CoverageSummaryDTO {
  generatedAt: string;
  sources: { key: string; name: string; collectedUntil: string | null; auto: boolean }[];
}

/** 公開・有効なソースの収集済みの日付。手入力の設定者・内部の設定は出さない。 */
export async function getSummary(clearance: string): Promise<CoverageSummaryDTO> {
  const sources = await getCollectionStatus(clearance, { publicOnly: true });
  return {
    generatedAt: new Date().toISOString(),
    sources: sources.map((s) => ({ key: s.key, name: s.name, collectedUntil: s.collectedUntil, auto: s.auto !== null })),
  };
}
