import { beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { CoverageInputError, CoveragePermissionError } from "@/lib/coverage/freshness";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), upsert: vi.fn(), matrix: vi.fn() }));
vi.mock("@/lib/api-auth", () => ({ requireApiAuth: mocks.auth }));
vi.mock("@/lib/domain/coverage", () => ({ upsertCell: mocks.upsert, getMatrix: mocks.matrix }));
import { PUT } from "./route";

const request = (body: unknown) => new Request("https://example.test/api/v1/coverage", { method: "PUT", body: JSON.stringify(body) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ id: "actor", clearance: "internal" });
});
it("認証・write 権限を通してから日付を保存する", async () => {
  mocks.upsert.mockResolvedValue({ confirmedUntil: "2026-10-01" });
  const body = { lensKey: "food", dataSourceKey: "talk", confirmedUntil: "2026-10-01" };
  expect((await PUT(request(body))).status).toBe(200);
  expect(mocks.upsert).toHaveBeenCalledWith(body, "internal", "actor");
  const denied = NextResponse.json({ error: "Forbidden" }, { status: 403 });
  mocks.auth.mockResolvedValue(denied);
  expect(await PUT(request(body))).toBe(denied);
  expect(mocks.upsert).toHaveBeenCalledOnce();
});
it("日付の省略と明示的な null を区別する", async () => {
  mocks.upsert.mockResolvedValue({});
  const body = { lensKey: "food", dataSourceKey: "talk", note: "メモ" };
  await PUT(request(body));
  expect(mocks.upsert.mock.calls[0][0]).not.toHaveProperty("confirmedUntil");
  await PUT(request({ ...body, confirmedUntil: null }));
  expect(mocks.upsert.mock.calls[1][0]).toHaveProperty("confirmedUntil", null);
});
it("壊れた JSON や不正な型・状態を保存しない", async () => {
  for (const body of [null, {}, { lensKey: 3, dataSourceKey: "talk" }, { lensKey: "food", dataSourceKey: "talk", status: "bad" }]) {
    expect((await PUT(request(body))).status).toBe(400);
  }
  expect((await PUT(new Request("https://example.test", { method: "PUT", body: "broken" }))).status).toBe(400);
  expect(mocks.upsert).not.toHaveBeenCalled();
});
it("検証エラー・権限エラーと内部例外を分け、内部情報は返さない", async () => {
  const body = { lensKey: "food", dataSourceKey: "talk" };
  for (const [error, status, message] of [
    [new CoverageInputError("日付が不正です"), 400, "日付が不正です"],
    [new CoveragePermissionError("更新権限がありません"), 403, "更新権限がありません"],
    [new Error("sensitive database error"), 400, "鮮度日付を更新できませんでした"],
  ] as const) {
    mocks.upsert.mockRejectedValue(error);
    const response = await PUT(request(body));
    expect(response.status).toBe(status);
    expect((await response.json()).error).toBe(message);
  }
});
