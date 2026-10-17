import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({ clearance: vi.fn(), audit: vi.fn(), raw: vi.fn(), derived: vi.fn() }));
vi.mock("@/lib/db", () => ({ withClearance: mocks.clearance }));
vi.mock("./audit", () => ({ logAudit: mocks.audit }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
import { getMatrix, getSummary, upsertCell } from "./coverage";

const lens = { id: "lens", key: "food", name: "食べたもの", description: "", sortOrder: 10, active: true, public: true, classification: "internal" };
const source = { id: "source", key: "blog", name: "ブログ", kind: "blog", description: null, sortOrder: 10, active: true, public: true, classification: "internal", itemRule: "blog_url", publisherPattern: null, titlePattern: null };
const date = new Date("2026-10-01T00:00:00Z");
const tx = {
  lens: { findUnique: vi.fn(), findMany: vi.fn() },
  dataSource: { findUnique: vi.fn(), findMany: vi.fn() },
  coverage: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
  lensItemCheck: { findMany: vi.fn() },
  $executeRaw: mocks.raw, $queryRaw: mocks.derived,
};
const existing = { id: "cell", lensId: lens.id, dataSourceId: source.id, status: "tracked", classification: "internal", note: "内部メモ", confirmedUntil: date, freshnessUpdatedAt: date, updatedAt: date };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.clearance.mockImplementation((_: string, fn: (db: unknown) => unknown) => fn(tx));
  tx.lens.findUnique.mockResolvedValue(lens);
  tx.dataSource.findUnique.mockResolvedValue(source);
  tx.lens.findMany.mockResolvedValue([lens]);
  tx.dataSource.findMany.mockResolvedValue([source]);
  tx.coverage.findUnique.mockResolvedValue(existing);
  tx.coverage.findMany.mockResolvedValue([existing]);
  tx.lensItemCheck.findMany.mockResolvedValue([]);
  tx.coverage.upsert.mockImplementation(async (args) => ({ ...existing, ...args.update, lens, dataSource: source }));
  mocks.derived.mockResolvedValue([]);
});

describe("鮮度日付の保存", () => {
  const input = { lensKey: "food", dataSourceKey: "blog" };
  it("日付変更と未確認への解除はどちらも明示設定を記録する", async () => {
    const saved = await upsertCell({ ...input, confirmedUntil: "2026-09-30" }, "internal", "user");
    expect(saved.confirmedUntil).toBe("2026-09-30");
    const cleared = await upsertCell({ ...input, confirmedUntil: null }, "internal", "user");
    expect(cleared.confirmedUntil).toBeNull();
    expect(cleared.freshnessUpdatedAt).not.toBeNull();
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.objectContaining({ actorId: "user", action: "coverage.update", metadata: expect.objectContaining({ confirmedUntil: null }) }));
  });
  it("日付や状態を省略した API 更新はその値を保持する", async () => {
    await upsertCell({ ...input, note: "メモのみ更新" }, "internal");
    const update = tx.coverage.upsert.mock.calls[0][0].update;
    expect(update).not.toHaveProperty("confirmedUntil");
    expect(update).not.toHaveProperty("freshnessUpdatedAt");
    expect(update).not.toHaveProperty("status");
  });
  it("不正な日付や状態は DB に触る前に拒否する", async () => {
    await expect(upsertCell({ ...input, confirmedUntil: "2026-02-30" }, "internal")).rejects.toThrow();
    await expect(upsertCell({ ...input, status: "invalid" as never }, "internal")).rejects.toThrow();
    expect(mocks.clearance).not.toHaveBeenCalled();
  });
  it("同じセルの初回作成もロックしてから既存機密を読み、機密を下げない", async () => {
    tx.coverage.findUnique.mockResolvedValue({ ...existing, classification: "confidential" });
    await upsertCell({ ...input, classification: "public" }, "restricted");
    expect(mocks.raw.mock.invocationCallOrder[0]).toBeLessThan(tx.coverage.findUnique.mock.invocationCallOrder[0]);
    expect(tx.coverage.upsert.mock.calls[0][0].update.classification).toBe("confidential");
  });
  it("新規行は親の機密を継承し、操作者の機密上限を検証する", async () => {
    tx.coverage.findUnique.mockResolvedValue(null);
    tx.dataSource.findUnique.mockResolvedValue({ ...source, classification: "confidential" });
    await expect(upsertCell(input, "internal")).rejects.toThrow("clearance");
    expect(tx.coverage.upsert).not.toHaveBeenCalled();
    await upsertCell(input, "restricted");
    expect(tx.coverage.upsert.mock.calls[0][0].create.classification).toBe("confidential");
  });
  it("見えない行との衝突は内部情報を返さず拒否する", async () => {
    tx.coverage.findUnique.mockResolvedValue(null);
    tx.coverage.upsert.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("sensitive", { code: "P2002", clientVersion: "test" }));
    await expect(upsertCell(input, "internal")).rejects.toThrow("現在の閲覧範囲");
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe("鮮度日付の表示と公開", () => {
  it("明示的に空にした日付は旧記録から復活させず、旧チェックも導出も読まない", async () => {
    tx.coverage.findMany.mockResolvedValue([{ ...existing, confirmedUntil: null }]);
    const matrix = await getMatrix("internal");
    expect(matrix.cells[0]).toMatchObject({ continuousUntil: null, dateOrigin: "manual" });
    expect(tx.lensItemCheck.findMany).not.toHaveBeenCalled();
    expect(mocks.derived).not.toHaveBeenCalled();
  });
  it("旧記録が無い未設定セルも全件導出しない", async () => {
    tx.coverage.findMany.mockResolvedValue([]);
    expect((await getMatrix("internal")).cells[0]).toMatchObject({ continuousUntil: null, dateOrigin: null });
    expect(mocks.derived).not.toHaveBeenCalled();
  });
  it("未編集セルは可視の旧チェックと導出素材で日付を表示する", async () => {
    tx.coverage.findMany.mockResolvedValue([{ ...existing, confirmedUntil: null, freshnessUpdatedAt: null }]);
    tx.lensItemCheck.findMany.mockResolvedValue([{ lensId: lens.id, dataSourceId: source.id, itemKey: "url" }]);
    mocks.derived.mockResolvedValue([{ itemKey: "url", itemDate: date, itemTitle: "素材" }]);
    expect((await getMatrix("internal")).cells[0]).toMatchObject({ continuousUntil: "2026-10-01", dateOrigin: "legacy" });
  });
  it("公開用は日付だけを返し、件数・内部メモ・設定日時を含めない", async () => {
    const summary = await getSummary("internal");
    expect(summary.lenses).toEqual([{ key: "food", name: "食べたもの", sources: [{ key: "blog", name: "ブログ", continuousUntil: "2026-10-01" }], minContinuousUntil: "2026-10-01" }]);
    expect(tx.lens.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { public: true, active: true } }));
    expect(tx.dataSource.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { public: true, active: true } }));
    expect((await getMatrix("internal", { publicOnly: true })).cells[0].note).toBeNull();
  });
  it("素材がない情報源も日付で管理でき、対象外は公開しない", async () => {
    tx.dataSource.findMany.mockResolvedValue([{ ...source, itemRule: "manual" }]);
    expect((await getSummary("internal")).lenses[0].sources).toHaveLength(1);
    tx.coverage.findMany.mockResolvedValue([{ ...existing, status: "not_applicable" }]);
    expect((await getSummary("internal")).lenses).toEqual([]);
  });
  it("一つでも日付未設定なら観点全体の日付も null", async () => {
    tx.dataSource.findMany.mockResolvedValue([source, { ...source, id: "s2", key: "talk", itemRule: "manual" }]);
    const summary = await getSummary("internal");
    expect(summary.lenses[0].sources).toHaveLength(2);
    expect(summary.lenses[0].minContinuousUntil).toBeNull();
  });
});
