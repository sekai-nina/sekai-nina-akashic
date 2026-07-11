/**
 * 収集カバレッジ管理 (観点 × データソース) のドメイン層。
 *
 * 「どの観点(Lens)を、どのデータソース(DataSource)に、何日の分まで反映したか」を
 * Coverage セルとして記録する。カーソルは日付1点 (YYYY-MM-DD) のみ。
 *
 * Lens / DataSource / Coverage は RLS 有効（direct-classification）。owner ベースは
 * 無いので withClearance(clearance, ...) で十分。日付は TZ 事故回避のため常に
 * UTC 00:00 に正規化し、外向きには YYYY-MM-DD 文字列で扱う。
 */

import { ClearanceLevel, CoverageStatus, DataSourceKind } from "@prisma/client";
import { withClearance } from "@/lib/db";
import { logAudit } from "./audit";

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
 * UTC 基準だと JST 0〜9時の「今日まで反映」が前日を記録してしまう。
 * 格納規約は従来どおり「YYYY-MM-DD の UTC 00:00」で不変。 */
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
}

export interface UpdateDataSourceInput {
  name?: string;
  kind?: DataSourceKind;
  description?: string | null;
  sortOrder?: number;
  active?: boolean;
  public?: boolean;
  classification?: ClearanceLevel;
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
// Coverage (マトリクス / セル upsert / summary)
// ============================================================

export interface CoverageCellDTO {
  id: string;
  lensId: string;
  dataSourceId: string;
  lensKey: string;
  dataSourceKey: string;
  status: CoverageStatus;
  collectedUntil: string | null; // YYYY-MM-DD
  note: string | null;
  updatedById: string | null;
  updatedAt: string;
}

export interface CoverageMatrixDTO {
  lenses: {
    id: string;
    key: string;
    name: string;
    description: string;
    sortOrder: number;
    active: boolean;
    public: boolean;
    classification: ClearanceLevel;
  }[];
  dataSources: {
    id: string;
    key: string;
    name: string;
    kind: DataSourceKind;
    description: string | null;
    sortOrder: number;
    active: boolean;
    public: boolean;
    classification: ClearanceLevel;
  }[];
  cells: CoverageCellDTO[];
}

/**
 * マトリクス全体を取得する。
 * options.publicOnly=true のとき public な Lens×DataSource のみ・cell の note を除去。
 */
export async function getMatrix(
  clearance: string,
  options: { publicOnly?: boolean } = {}
): Promise<CoverageMatrixDTO> {
  const { publicOnly = false } = options;

  return withClearance(clearance, async (tx) => {
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

    const lensIds = new Set(lenses.map((l) => l.id));
    const dsIds = new Set(dataSources.map((d) => d.id));

    const cells: CoverageCellDTO[] = coverages
      .filter((c) => lensIds.has(c.lensId) && dsIds.has(c.dataSourceId))
      .map((c) => ({
        id: c.id,
        lensId: c.lensId,
        dataSourceId: c.dataSourceId,
        lensKey: c.lens.key,
        dataSourceKey: c.dataSource.key,
        status: c.status,
        collectedUntil: toDateOnlyString(c.collectedUntil),
        note: publicOnly ? null : c.note,
        updatedById: c.updatedById,
        updatedAt: c.updatedAt.toISOString(),
      }));

    return {
      lenses: lenses.map((l) => ({
        id: l.id,
        key: l.key,
        name: l.name,
        description: l.description,
        sortOrder: l.sortOrder,
        active: l.active,
        public: l.public,
        classification: l.classification,
      })),
      dataSources: dataSources.map((d) => ({
        id: d.id,
        key: d.key,
        name: d.name,
        kind: d.kind,
        description: d.description,
        sortOrder: d.sortOrder,
        active: d.active,
        public: d.public,
        classification: d.classification,
      })),
      cells,
    };
  });
}

export interface UpsertCellInput {
  lensKey: string;
  dataSourceKey: string;
  status?: CoverageStatus;
  collectedUntil?: string | null; // YYYY-MM-DD
  note?: string | null;
  classification?: ClearanceLevel;
}

/**
 * セルを upsert する（lensKey + dataSourceKey で特定）。
 * status=not_applicable のときは collectedUntil を強制的に null にする。
 */
export async function upsertCell(
  input: UpsertCellInput,
  clearance: string,
  actorId?: string | null
): Promise<CoverageCellDTO> {
  const status: CoverageStatus = input.status ?? "tracked";
  const collectedUntil =
    status === "not_applicable" ? null : parseDateOnly(input.collectedUntil);

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
        collectedUntil,
        note: input.note ?? null,
        classification: input.classification ?? "internal",
        updatedById: actorId ?? null,
      },
      update: {
        status,
        collectedUntil,
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
      collectedUntil: toDateOnlyString(collectedUntil),
    },
  });

  return {
    id: cell.id,
    lensId: cell.lensId,
    dataSourceId: cell.dataSourceId,
    lensKey: cell.lens.key,
    dataSourceKey: cell.dataSource.key,
    status: cell.status,
    collectedUntil: toDateOnlyString(cell.collectedUntil),
    note: cell.note,
    updatedById: cell.updatedById,
    updatedAt: cell.updatedAt.toISOString(),
  };
}

/**
 * 行 (Lens) 単位で「今日まで反映」する。
 * 既存の tracked セルのみを今日 (UTC) に前進させる（not_applicable と未着手には触れない）。
 * 更新した件数を返す。
 */
export async function advanceRowToToday(
  lensKey: string,
  clearance: string,
  actorId?: string | null
): Promise<number> {
  const today = todayDateOnly();

  const count = await withClearance(clearance, async (tx) => {
    const lens = await tx.lens.findUnique({ where: { key: lensKey } });
    if (!lens) throw new Error(`Lens not found: ${lensKey}`);
    const result = await tx.coverage.updateMany({
      where: { lensId: lens.id, status: "tracked" },
      data: { collectedUntil: today, updatedById: actorId ?? null },
    });
    return result.count;
  });

  if (count > 0) {
    await logAudit({
      actorId,
      action: "coverage.update",
      targetType: "Lens",
      targetId: lensKey,
      metadata: { op: "advanceRowToToday", lensKey, count, date: toDateOnlyString(today) },
    });
  }

  return count;
}

// ============================================================
// Summary (サイト公開用の要約)
// ============================================================

export interface CoverageSummaryDTO {
  generatedAt: string;
  lenses: {
    key: string;
    name: string;
    sources: { key: string; name: string; collectedUntil: string }[];
    minCollectedUntil: string;
  }[];
}

/**
 * サイト公開用の要約を生成する。
 * - public な Lens × public な DataSource のみ（いずれも active）
 * - tracked かつ collectedUntil あり のセルのみ（not_applicable / 未着手は除外）
 * - note は含めない
 * - minCollectedUntil = その観点で最も遅れているソースの日付
 * - tracked ソースが1つも無い Lens は含めない
 */
export async function getSummary(clearance: string): Promise<CoverageSummaryDTO> {
  return withClearance(clearance, async (tx) => {
    const [lenses, coverages] = await Promise.all([
      tx.lens.findMany({
        where: { public: true, active: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      tx.coverage.findMany({
        where: {
          status: "tracked",
          collectedUntil: { not: null },
          lens: { public: true, active: true },
          dataSource: { public: true, active: true },
        },
        include: {
          dataSource: { select: { key: true, name: true, sortOrder: true } },
        },
      }),
    ]);

    // lensId -> sorted sources
    const byLens = new Map<
      string,
      { key: string; name: string; sortOrder: number; collectedUntil: string }[]
    >();
    for (const c of coverages) {
      const arr = byLens.get(c.lensId) ?? [];
      arr.push({
        key: c.dataSource.key,
        name: c.dataSource.name,
        sortOrder: c.dataSource.sortOrder,
        collectedUntil: toDateOnlyString(c.collectedUntil)!,
      });
      byLens.set(c.lensId, arr);
    }

    const resultLenses = lenses
      .map((l) => {
        const sources = (byLens.get(l.id) ?? []).sort(
          (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)
        );
        if (sources.length === 0) return null;
        const minCollectedUntil = sources.reduce(
          (min, s) => (s.collectedUntil < min ? s.collectedUntil : min),
          sources[0].collectedUntil
        );
        return {
          key: l.key,
          name: l.name,
          sources: sources.map((s) => ({
            key: s.key,
            name: s.name,
            collectedUntil: s.collectedUntil,
          })),
          minCollectedUntil,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return {
      generatedAt: new Date().toISOString(),
      lenses: resultLenses,
    };
  });
}
