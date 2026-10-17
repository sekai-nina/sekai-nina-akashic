import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), source: vi.fn(), clearance: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({
  withClearance: mocks.clearance,
}));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); },
}));
import Page from "./page";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "user", clearance: "internal" } });
  mocks.clearance.mockImplementation((_: string, fn: (tx: unknown) => unknown) => fn({ dataSource: { findUnique: mocks.source } }));
});

it("旧リンクから素材のクリップ進捗へ遷移する", async () => {
  mocks.source.mockResolvedValue({ key: "talk" });
  await expect(Page({ params: Promise.resolve({ sourceKey: "talk" }) })).rejects.toThrow("REDIRECT:/progress/materials/talk");
  expect(mocks.clearance).toHaveBeenCalledWith("internal", expect.any(Function));
  expect(mocks.source).toHaveBeenCalledWith({ where: { key: "talk" }, select: { key: true } });
});

it("見えないソースは 404 にする", async () => {
  mocks.source.mockResolvedValue(null);
  await expect(Page({ params: Promise.resolve({ sourceKey: "hidden" }) })).rejects.toThrow("NOT_FOUND");
});

it("未認証ならソースも照会しない", async () => {
  mocks.auth.mockResolvedValue(null);
  await expect(Page({ params: Promise.resolve({ sourceKey: "talk" }) })).rejects.toThrow("NOT_FOUND");
  expect(mocks.clearance).not.toHaveBeenCalled();
});

it("標準12ソース以外の旧リンクは鮮度画面へ戻す", async () => {
  mocks.source.mockResolvedValue({ key: "custom_source" });
  await expect(Page({ params: Promise.resolve({ sourceKey: "custom_source" }) })).rejects.toThrow("REDIRECT:/coverage");
});
