import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { CoverageInputError, CoverageNotFoundError } from "@/lib/coverage/collection";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/api-auth", () => ({ requireApiAuth: mocks.auth }));
vi.mock("@/lib/domain/coverage", () => ({ updateDataSource: mocks.update }));
import { PATCH } from "./route";

const params = { params: Promise.resolve({ id: "ds" }) };
const patch = (body: string) =>
  PATCH(new Request("https://example.test/api/v1/datasources/ds", { method: "PATCH", body }), params);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ id: "user", clearance: "internal" });
  mocks.update.mockResolvedValue({ id: "ds", key: "magazine" });
});

describe("PATCH /api/v1/datasources/:id", () => {
  it("収集済みの日付を他の項目と一緒に 1 回で渡す", async () => {
    const res = await patch(JSON.stringify({ name: "雑誌", collectedUntil: "2026-10-01" }));
    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0][1]).toMatchObject({ name: "雑誌", collectedUntil: "2026-10-01" });
  });

  it.each(["not-json", "null", "[]", JSON.stringify({ collectedUntil: 20261001 })])("不正な本文 %s は 400 で何も書かない", async (body) => {
    expect((await patch(body)).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([
    [new CoverageInputError("手では入力できません"), 400],
    [new CoverageNotFoundError("見つかりません"), 404],
    [new Prisma.PrismaClientKnownRequestError("x", { code: "P2025", clientVersion: "6" }), 404],
  ])("ドメインのエラーを状態コードに写す (%s)", async (error, status) => {
    mocks.update.mockRejectedValue(error);
    expect((await patch(JSON.stringify({ collectedUntil: "2026-10-01" }))).status).toBe(status);
  });
});
