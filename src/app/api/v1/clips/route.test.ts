import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { ClipAssetNotFoundError, ClipForbiddenError, ClipInputError } from "@/lib/clips/errors";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/api-auth", () => ({ requireApiAuth: mocks.auth }));
vi.mock("@/lib/domain/clips", () => ({ createClip: mocks.create }));
vi.mock("@/lib/cache", () => ({ invalidateDossiers: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { POST } from "./route";

const post = (body: string) =>
  POST(new Request("https://example.test/api/v1/clips", { method: "POST", body }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ id: "bot", role: "member", clearance: "internal", apiKeyId: "key" });
  mocks.create.mockResolvedValue({ id: "item", excerptStart: 3, excerptEnd: 8 });
});

describe("POST /api/v1/clips", () => {
  it("clip か write のキーで通し、作ったクリップを 201 で返す", async () => {
    const res = await post(JSON.stringify({ assetId: "a1", note: "メモ", excerpt: "引用", requestedBy: "nina_fan" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "item", assetId: "a1", located: true });
    expect(mocks.auth.mock.calls[0][1]).toEqual(["clip", "write"]);
    expect(mocks.create.mock.calls[0][1]).toEqual({
      assetId: "a1",
      note: "メモ",
      excerpt: "引用",
      auditMetadata: { apiKeyId: "key", requestedBy: "nina_fan" },
    });
  });

  it("位置が見つからなければ located: false", async () => {
    mocks.create.mockResolvedValue({ id: "item", excerptStart: null, excerptEnd: null });
    const res = await post(JSON.stringify({ assetId: "a1", note: "メモ" }));
    expect((await res.json()).located).toBe(false);
  });

  it("認証に失敗したらそのまま返す", async () => {
    mocks.auth.mockResolvedValue(NextResponse.json({ error: "x" }, { status: 403 }));
    expect((await post(JSON.stringify({ assetId: "a1", note: "メモ" }))).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("viewer のキーは 403 で何も書かない", async () => {
    mocks.auth.mockResolvedValue({ id: "v", role: "viewer", clearance: "internal", apiKeyId: "key" });
    expect((await post(JSON.stringify({ assetId: "a1", note: "メモ" }))).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(["not-json", "null", "[]", JSON.stringify({ note: "assetId が無い" }), JSON.stringify({ assetId: 1 })])(
    "不正な本文 %s は 400 で何も書かない",
    async (body) => {
      expect((await post(body)).status).toBe(400);
      expect(mocks.create).not.toHaveBeenCalled();
    }
  );

  it.each([
    [new ClipAssetNotFoundError("アセットが見つかりません"), 404],
    [new ClipForbiddenError("クリップを作る権限がありません"), 403],
    [new ClipInputError("メモか引用のどちらかを入れてください"), 400],
  ])("ドメインのエラーを状態コードに写す (%s)", async (error, status) => {
    mocks.create.mockRejectedValue(error);
    expect((await post(JSON.stringify({ assetId: "a1" }))).status).toBe(status);
  });
});
