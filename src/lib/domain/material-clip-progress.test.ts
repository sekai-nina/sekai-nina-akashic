import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => {
  const tx = {
    dataSource: { findUnique: vi.fn(), findMany: vi.fn() },
    materialClipStatus: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    asset: { findMany: vi.fn(), findUnique: vi.fn() },
    article: { findMany: vi.fn() }, dossierItem: { groupBy: vi.fn() }, $queryRaw: vi.fn(), $executeRaw: vi.fn(),
  };
  return { tx, withClearance: vi.fn(), withSession: vi.fn(), derived: vi.fn(), derive: vi.fn(), authors: vi.fn(), mentions: vi.fn(), audit: vi.fn() };
});
vi.mock("@/lib/db", () => ({ withClearance: mocks.withClearance, withSession: mocks.withSession }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn }));
vi.mock("./coverage", async () => {
  // DB を開かず、素材の導出結果とソース条件を差し替える。
  const { Prisma } = await import("@prisma/client");
  return {
    getDerivedItems: mocks.derived, deriveItems: mocks.derive,
    toDateOnlyString: (d: Date | null) => d?.toISOString().slice(0, 10) ?? null,
    TALK_DAY_SQL: Prisma.sql`(((a."canonicalDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Tokyo')::date)`,
    sourcePatternConds: () => [],
  };
});
vi.mock("./coverage-items", () => ({ getSourceAuthorKeys: mocks.authors, getSourceMentionKeys: mocks.mentions }));
vi.mock("./audit", () => ({ logAudit: mocks.audit }));

import { findMaterialClipProgressForAsset, listMaterialClipProgress, setMaterialClipProgress } from "./material-clip-progress";
const user = { id: "user", clearance: "internal" };
const source = {
  id: "blog-source", key: "blog", itemRule: "blog_url", publisherPattern: "公式ブログ%", titlePattern: null, classification: "internal",
};
const url = "https://blog.test/1";
const a = {
  id: "a1", kind: "text", title: "ブログ", classification: "internal", canonicalDate: new Date("2026-10-15T15:00:00Z"),
  sourceRecords: [
    { url, title: "ブログ", publisher: "公式ブログ", classification: "internal" },
    { url, title: "ブログ画像", publisher: "公式ブログ", classification: "internal" },
  ],
};
const item = (key: string) => ({ itemKey: key, itemDate: new Date("2026-10-16T00:00:00Z"), itemTitle: key });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.withClearance.mockImplementation(async (_clearance, fn) => fn(mocks.tx));
  mocks.withSession.mockImplementation(async (_user, fn) => fn(mocks.tx));
  mocks.tx.dataSource.findUnique.mockResolvedValue(source);
  mocks.tx.dataSource.findMany.mockResolvedValue([source]);
  mocks.tx.materialClipStatus.findMany.mockResolvedValue([]);
  mocks.tx.materialClipStatus.findUnique.mockResolvedValue(null);
  mocks.tx.materialClipStatus.upsert.mockResolvedValue({ id: "status" });
  mocks.tx.asset.findMany.mockResolvedValue([a]);
  mocks.tx.asset.findUnique.mockResolvedValue(a);
  mocks.tx.$queryRaw.mockResolvedValue([{ id: "a1" }]);
  mocks.tx.dossierItem.groupBy.mockResolvedValue([{ assetId: "a1", _count: { _all: 3 } }]);
  mocks.derived.mockResolvedValue([item(url)]);
  mocks.derive.mockResolvedValue([item(url)]);
  mocks.authors.mockResolvedValue([url]);
  mocks.mentions.mockResolvedValue([]);
});

describe("素材のクリップ進捗の一覧", () => {
  it("本人著・言及・手動対象を分母にし、消えた素材の状態を数えない", async () => {
    // 自動対象の導出と、手動対象の引き足し。消えた素材 (deleted) は導出で返らない
    mocks.derive.mockResolvedValueOnce([item(url), item("mention")]).mockResolvedValueOnce([item("manual")]);
    mocks.mentions.mockResolvedValue(["mention"]);
    mocks.tx.materialClipStatus.findMany.mockResolvedValue([
      { itemKey: url, done: true, included: true }, { itemKey: "manual", done: false, included: true },
      { itemKey: "deleted", done: true, included: true }, { itemKey: "untouched", done: false, included: false },
    ]);
    const result = await listMaterialClipProgress(user, "blog");
    expect(result).toMatchObject({ total: 3, done: 1 });
    expect(new Set(result.items.map((i) => i.itemKey))).toEqual(new Set([url, "mention", "manual"]));
  });
  it("ソース全体は導出せず、関連キーと状態のある素材だけを引く", async () => {
    mocks.mentions.mockResolvedValue(["mention"]);
    mocks.tx.materialClipStatus.findMany.mockResolvedValue([
      { itemKey: "manual", done: false, included: true }, { itemKey: "untouched", done: false, included: false },
    ]);
    await listMaterialClipProgress(user, "blog");
    expect(mocks.derived).not.toHaveBeenCalled();
    // 自動対象 (済の状態に依存しないのでキャッシュできる) と、手動対象の引き足しを分ける
    expect(new Set(mocks.derive.mock.calls[0][2].onlyKeys)).toEqual(new Set([url, "mention"]));
    expect(mocks.derive.mock.calls[1][2].onlyKeys).toEqual(["manual"]);
  });
  it("手動対象が無ければ引き足さない", async () => {
    await listMaterialClipProgress(user, "blog");
    expect(mocks.derive).toHaveBeenCalledTimes(1);
    expect(mocks.authors).toHaveBeenCalledWith("blog", "internal");
    expect(mocks.mentions).toHaveBeenCalledWith("blog", "internal");
  });
  it("行のリンク先は画像より本文のアセットを優先する", async () => {
    mocks.tx.$queryRaw.mockResolvedValue([{ id: "img" }, { id: "a1" }]);
    mocks.tx.asset.findMany.mockResolvedValue([{ ...a, id: "img", kind: "image" }, a]);
    expect((await listMaterialClipProgress(user, "blog")).items[0].assetId).toBe("a1");
  });
  it("URL 重複で水増しせず、移動先も含む全ドシエの件数を withSession で数える", async () => {
    const result = await listMaterialClipProgress(user, "blog");
    expect(result.items[0]).toMatchObject({ clipCount: 3, assetId: "a1" });
    expect(mocks.withSession).toHaveBeenCalledWith(user, expect.any(Function), expect.any(Object));
    expect(mocks.tx.dossierItem.groupBy).toHaveBeenCalledWith({
      by: ["assetId"], where: { assetId: { in: ["a1"] }, kind: "asset_ref" }, _count: { _all: true },
    });
  });
  it("トークは関連判定を掛けず全件を対象にする。空の一覧の割合は 0 件", async () => {
    mocks.tx.dataSource.findUnique.mockResolvedValue({ ...source, key: "talk", itemRule: "talk_date" });
    mocks.derived.mockResolvedValue([item("2026-10-16")]);
    expect((await listMaterialClipProgress(user, "talk")).total).toBe(1);
    expect(mocks.authors).not.toHaveBeenCalled();
    mocks.derived.mockResolvedValue([]);
    expect(await listMaterialClipProgress(user, "talk")).toMatchObject({ total: 0, done: 0, items: [], page: 1 });
  });
});

describe("素材のクリップ進捗の保存", () => {
  it("済は対象にも含める。済の解除では手動対象を上書きしない", async () => {
    await setMaterialClipProgress(user, "blog", url, { done: true });
    expect(mocks.tx.materialClipStatus.upsert.mock.calls[0][0].create).toMatchObject({
      dataSourceKey: "blog", itemKey: url, done: true, included: true, classification: "internal", updatedById: "user",
    });
    await setMaterialClipProgress(user, "blog", url, { done: false });
    expect(mocks.tx.materialClipStatus.upsert.mock.calls[1][0].update).toEqual({
      done: false, classification: "internal", updatedById: "user",
    });
  });
  it("手動対象を解除すると済も外す", async () => {
    await setMaterialClipProgress(user, "blog", url, { included: false });
    expect(mocks.tx.materialClipStatus.upsert.mock.calls[0][0].update).toMatchObject({ included: false, done: false });
  });
  it("導出できないキー・存在しないソースに書き込まない", async () => {
    mocks.derive.mockResolvedValue([]);
    await expect(setMaterialClipProgress(user, "blog", "forged", { done: true })).rejects.toThrow("素材が見つかりません");
    await expect(setMaterialClipProgress(user, "forged", url, { done: true })).rejects.toThrow("不正");
    expect(mocks.tx.materialClipStatus.upsert).not.toHaveBeenCalled();
  });
  it("アセットの機密を継承し、操作者より高い機密では書かない", async () => {
    mocks.tx.asset.findMany.mockResolvedValue([{ ...a, classification: "confidential" }]);
    await expect(setMaterialClipProgress(user, "blog", url, { done: true })).rejects.toThrow("insufficient clearance");
    expect(mocks.tx.materialClipStatus.upsert).not.toHaveBeenCalled();
  });
});

it("アセット詳細も同じ JST 日付で状態を逆引きする", async () => {
  mocks.tx.dataSource.findMany.mockResolvedValue([{ ...source, key: "talk", itemRule: "talk_date" }]);
  mocks.tx.materialClipStatus.findMany.mockResolvedValue([{ dataSourceKey: "talk", itemKey: "2026-10-16", done: true }]);
  expect(await findMaterialClipProgressForAsset("a1", "internal")).toMatchObject([
    { sourceKey: "talk", itemKey: "2026-10-16", done: true },
  ]);
});


it("同じ素材の状態を読む前にトランザクション内で排他する", async () => {
  await setMaterialClipProgress(user, "blog", url, { done: true });
  expect(mocks.tx.$executeRaw).toHaveBeenCalledOnce();
  const [parts, key] = mocks.tx.$executeRaw.mock.calls[0];
  expect(parts.join("?")).toContain("pg_advisory_xact_lock(hashtextextended(");
  expect(key).toBe(JSON.stringify(["blog", url]));
  expect(mocks.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.derive.mock.invocationCallOrder[0]);
  expect(mocks.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.tx.materialClipStatus.findUnique.mock.invocationCallOrder[0]);
});

it("見えない共有状態との競合は、内部のエラー情報を出さず権限エラーにする", async () => {
  mocks.tx.materialClipStatus.upsert.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("private details", { code: "P2002", clientVersion: "test" }));
  await expect(setMaterialClipProgress(user, "blog", url, { done: true })).rejects.toThrow("現在の閲覧範囲では、この素材の共有進捗を更新できません");
  expect(mocks.audit).not.toHaveBeenCalled();
});

it("出典レコードのないラジオ録音も一覧の件数と保存時の機密継承に含める", async () => {
  const radioSource = { ...source, key: "radio", itemRule: "manual", publisherPattern: null };
  mocks.tx.dataSource.findUnique.mockResolvedValue(radioSource);
  mocks.tx.article.findMany.mockResolvedValue([{
    shortId: "radio1", title: "【1年目】ラジオ出演一覧",
    body: "| # | 放送日 | 番組名 |\n| --- | --- | --- |\n| 1 | 2026/10/16 | OH!MY CHANNEL! |",
  }]);
  mocks.tx.asset.findMany.mockResolvedValue([{ ...a, title: "OH!MY CHANNEL! 録音", sourceRecords: [], classification: "confidential" }]);
  const result = await listMaterialClipProgress({ ...user, clearance: "restricted" }, "radio");
  expect(result.items[0]).toMatchObject({ assetId: "a1", clipCount: 3 });
  expect(mocks.tx.$queryRaw.mock.calls[0][0].join("?")).toContain('LEFT JOIN "SourceRecord"');
  await setMaterialClipProgress({ ...user, clearance: "restricted" }, "radio", "radio1:1", { done: true });
  expect(mocks.tx.materialClipStatus.upsert.mock.calls[0][0].create).toMatchObject({ classification: "confidential" });
});
