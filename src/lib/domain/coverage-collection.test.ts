import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({ clearance: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/db", () => ({ withClearance: mocks.clearance }));
vi.mock("./audit", () => ({ logAudit: mocks.audit }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
import { getCollectionStatus, getSummary, setCollectedUntil, updateDataSource } from "./coverage";

const base = { kind: "blog", description: null, sortOrder: 10, active: true, public: true, classification: "internal", itemRule: "blog_url", publisherPattern: null, titlePattern: null, collectedUntil: null, collectedUntilUpdatedAt: null, collectedUntilUpdatedById: null };
const blog = { ...base, id: "blog-id", key: "blog", name: "公式ブログ" };
const magazine = {
  ...base, id: "mag-id", key: "magazine", name: "雑誌", kind: "magazine", itemRule: "source_url",
  collectedUntil: new Date("2026-10-01T00:00:00Z"), collectedUntilUpdatedAt: new Date("2026-10-20T03:00:00Z"), collectedUntilUpdatedById: "user",
};
const tx = {
  dataSource: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  job: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.clearance.mockImplementation((_: string, fn: (db: unknown) => unknown) => fn(tx));
  tx.dataSource.findMany.mockResolvedValue([blog, magazine]);
  tx.job.findMany.mockResolvedValue([
    { key: "bot.blog_watch", name: "bot.blog_watch", lastOkAt: new Date("2026-10-24T17:06:20Z"), lastStatus: "ok" },
  ]);
  tx.user.findMany.mockResolvedValue([{ id: "user", name: "運営" }]);
  tx.dataSource.findUnique.mockResolvedValue({ id: magazine.id });
  tx.dataSource.update.mockImplementation(async ({ data }) => ({ ...magazine, ...data }));
});

describe("収集済みの日付の一覧", () => {
  it("bot のあるソースは最終成功の JST 日付、無いソースは手入力の日付", async () => {
    const [b, m] = await getCollectionStatus("internal");
    expect(b).toMatchObject({ collectedUntil: "2026-10-25", auto: { jobKey: "bot.blog_watch", jobName: null }, manual: null });
    expect(m).toMatchObject({ collectedUntil: "2026-10-01", auto: null, manual: { updatedByName: "運営" } });
  });

  it("bot の報告が無ければ未確認", async () => {
    tx.job.findMany.mockResolvedValue([]);
    expect((await getCollectionStatus("internal"))[0]).toMatchObject({ collectedUntil: null, auto: { lastOkAt: null } });
  });

  it("公開用は公開・有効なソースに絞り、設定者を引かない", async () => {
    const summary = await getSummary("internal");
    expect(tx.dataSource.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { public: true, active: true, classification: { in: ["public", "internal"] } },
    }));
    expect(tx.user.findMany).not.toHaveBeenCalled();
    expect(summary.sources).toEqual([
      { key: "blog", name: "公式ブログ", collectedUntil: "2026-10-25", auto: true },
      { key: "magazine", name: "雑誌", collectedUntil: "2026-10-01", auto: false },
    ]);
  });
});

describe("手入力の収集済みの日付", () => {
  it("日付と設定者を保存し、null で未確認に戻す", async () => {
    await setCollectedUntil("magazine", "2026-10-10", "internal", "user");
    expect(tx.dataSource.update.mock.calls[0][0].data).toMatchObject({
      collectedUntil: new Date("2026-10-10T00:00:00Z"), collectedUntilUpdatedById: "user",
    });
    await setCollectedUntil("magazine", null, "internal", "user");
    expect(tx.dataSource.update.mock.calls[1][0].data.collectedUntil).toBeNull();
    expect(mocks.audit).toHaveBeenCalledTimes(2);
  });

  it("bot のあるソースは手入力を拒否する", async () => {
    await expect(setCollectedUntil("blog", "2026-10-10", "internal")).rejects.toThrow("自動");
    expect(tx.dataSource.update).not.toHaveBeenCalled();
  });

  it("不正な日付と見えないソースを拒否する", async () => {
    await expect(setCollectedUntil("magazine", "2026-02-30", "internal")).rejects.toThrow();
    tx.dataSource.findUnique.mockResolvedValue(null);
    await expect(setCollectedUntil("magazine", "2026-10-10", "internal")).rejects.toThrow("見つかりません");
  });

  it("RLS の競合は権限エラーにする", async () => {
    tx.dataSource.update.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("x", { code: "P2025", clientVersion: "6" }));
    await expect(setCollectedUntil("magazine", "2026-10-10", "internal")).rejects.toThrow("現在の閲覧範囲");
  });
});

describe("データソースの更新（REST の PATCH）", () => {
  beforeEach(() => tx.dataSource.findUnique.mockResolvedValue({ key: "magazine" }));

  it("他の項目と収集済みの日付を 1 回の update で書く", async () => {
    await updateDataSource("mag-id", { name: "雑誌（全誌）", collectedUntil: "2026-10-10" }, "internal", "user");
    expect(tx.dataSource.update).toHaveBeenCalledTimes(1);
    expect(tx.dataSource.update.mock.calls[0][0].data).toMatchObject({
      name: "雑誌（全誌）", collectedUntil: new Date("2026-10-10T00:00:00Z"), collectedUntilUpdatedById: "user",
    });
  });

  it("日付を送らなければ収集済みの日付に触れない", async () => {
    await updateDataSource("mag-id", { name: "雑誌" }, "internal", "user");
    expect(tx.dataSource.findUnique).not.toHaveBeenCalled();
    expect(tx.dataSource.update.mock.calls[0][0].data).not.toHaveProperty("collectedUntil");
  });

  it.each([
    ["不正な日付", "magazine", "2026/10/01"],
    ["自動のソース", "blog", "2026-10-01"],
  ])("%s なら他の項目も書かない", async (_, key, value) => {
    tx.dataSource.findUnique.mockResolvedValue({ key });
    await expect(updateDataSource("id", { public: false, collectedUntil: value }, "internal")).rejects.toThrow();
    expect(tx.dataSource.update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("見えないソースは見つからない扱い", async () => {
    tx.dataSource.findUnique.mockResolvedValue(null);
    await expect(updateDataSource("id", { collectedUntil: "2026-10-01" }, "internal")).rejects.toThrow("見つかりません");
  });
});
