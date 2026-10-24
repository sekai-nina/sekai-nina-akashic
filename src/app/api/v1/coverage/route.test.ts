import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/api-auth", () => ({ requireApiAuth: mocks.auth }));
import { GET, PUT } from "./route";
import { GET as getItems } from "./items/route";
import { GET as getLenses, POST as postLens } from "../lenses/route";
import { PATCH as patchLens } from "../lenses/[id]/route";
import { PUT as putCheck } from "./checks/route";
import { POST as postChecks } from "./checks/bulk/route";

beforeEach(() => vi.resetAllMocks());

describe.each([
  ["マトリクスの取得", GET, "read"],
  ["セルの更新", PUT, "write"],
  ["アイテム一覧", getItems, "read"],
  ["観点の一覧", getLenses, "read"],
  ["観点の作成", postLens, "write"],
  ["観点の更新", patchLens, "write"],
  ["単一チェック", putCheck, "write"],
  ["一括チェック", postChecks, "write"],
] as const)("終了した%s", (_, handler, permission) => {
  it("認証と権限の拒否を維持する", async () => {
    for (const status of [401, 403]) {
      const denied = NextResponse.json({ error: "Forbidden" }, { status });
      mocks.auth.mockResolvedValue(denied);
      const request = new Request("https://example.test/api/v1/coverage");
      expect(await handler(request)).toBe(denied);
      expect(mocks.auth).toHaveBeenLastCalledWith(request, permission);
    }
  });

  it("410 で止め、本文を処理しない", async () => {
    mocks.auth.mockResolvedValue({ id: "user", clearance: "internal" });
    const request = new Request("https://example.test/api/v1/coverage", { method: "PUT", body: "invalid-json" });
    const response = await handler(request);
    expect(response.status).toBe(410);
    expect((await response.json()).error).toContain("collectedUntil");
    expect(request.bodyUsed).toBe(false);
  });
});
