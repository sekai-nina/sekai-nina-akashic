import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), source: vi.fn(), response: vi.fn() }));
vi.mock("@/lib/api-auth", () => ({ requireApiAuth: mocks.auth }));
vi.mock("@/lib/domain/video-scenes", () => ({ getSceneSource: mocks.source }));
vi.mock("@/lib/video-scenes/media-response", () => ({ sceneMediaResponse: mocks.response }));
import { GET } from "./route";
const context = { params: Promise.resolve({ id: "asset" }) };
beforeEach(() => vi.resetAllMocks());
describe("ワーカー用の元動画取得", () => {
  it("Cookie ではなく専用権限のキーで認証する", async () => {
    mocks.auth.mockResolvedValue({ clearance: "internal" });
    const file = { storageKey: "private-drive" };
    mocks.source.mockResolvedValue(file);
    mocks.response.mockResolvedValue(new Response(null, { status: 206 }));
    const request = new Request("https://local/api/v1/video-scenes/assets/asset/source", { headers: { Authorization: "Bearer ak_test", Range: "bytes=0-1" } });
    expect((await GET(request, context)).status).toBe(206);
    expect(mocks.auth).toHaveBeenCalledWith(request, ["video_scene_worker", "read"]);
    expect(mocks.source).toHaveBeenCalledWith("internal", "asset");
    expect(mocks.response).toHaveBeenCalledWith(request, file);
  });
  it("認証失敗なら元動画に触れない", async () => {
    mocks.auth.mockResolvedValue(NextResponse.json({}, { status: 401 }));
    expect((await GET(new Request("https://local/source"), context)).status).toBe(401);
    expect(mocks.source).not.toHaveBeenCalled();
  });
  it("キーの機密レベルで見えない元動画は取得しない", async () => {
    mocks.auth.mockResolvedValue({ clearance: "public" });
    mocks.source.mockResolvedValue(null);
    expect((await GET(new Request("https://local/source"), context)).status).toBe(404);
    expect(mocks.response).not.toHaveBeenCalled();
  });
});
