import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/api-auth", () => ({ requireApiAuth: mocks.auth }));
import { PUT } from "./route";
import { POST } from "./bulk/route";

beforeEach(() => vi.resetAllMocks());

describe.each([["単一チェック", PUT], ["一括チェック", POST]] as const)("終了した%s", (_, handler) => {
  it("認証と write 権限の拒否を維持する", async () => {
    for (const status of [401, 403]) {
      const denied = NextResponse.json({ error: "Forbidden" }, { status });
      mocks.auth.mockResolvedValue(denied);
      const request = new Request("https://example.test/api/v1/coverage/checks");
      expect(await handler(request)).toBe(denied);
      expect(mocks.auth).toHaveBeenLastCalledWith(request, "write");
    }
  });

  it("古いクライアントの書き込みを 410 で止め、本文を処理しない", async () => {
    mocks.auth.mockResolvedValue({ id: "user", clearance: "internal" });
    const request = new Request("https://example.test/api/v1/coverage/checks", { method: "PUT", body: "invalid-json" });
    const response = await handler(request);
    expect(response.status).toBe(410);
    expect((await response.json()).error).toContain("/progress");
    expect(request.bodyUsed).toBe(false);
  });
});
