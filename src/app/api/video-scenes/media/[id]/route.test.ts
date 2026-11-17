import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), apiAuth: vi.fn(), file: vi.fn(), source: vi.fn(), response: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/api-auth", () => ({ requireApiAuth: mocks.apiAuth }));
vi.mock("@/lib/domain/video-scenes", () => ({ getSceneFile: mocks.file, getSceneSource: mocks.source }));
vi.mock("@/lib/video-scenes/media-response", () => ({ sceneMediaResponse: mocks.response }));
import { GET } from "./route";
const context = { params: Promise.resolve({ id: "file" }) };
beforeEach(() => vi.resetAllMocks());
describe("素材の認証", () => {
  it("未認証ならファイルにも Drive にも触れない", async () => {
    mocks.auth.mockResolvedValue(null);
    mocks.apiAuth.mockResolvedValue(NextResponse.json({ error: "unauthorized" }, { status: 401 }));
    expect((await GET(new Request("https://local/media"), context)).status).toBe(401);
    expect(mocks.file).not.toHaveBeenCalled(); expect(mocks.response).not.toHaveBeenCalled();
  });
  it("見えない親動画のファイルは 404 になり、実体を取得しない", async () => {
    mocks.auth.mockResolvedValue({ user: { clearance: "internal" } }); mocks.file.mockResolvedValue(null);
    expect((await GET(new Request("https://local/media"), context)).status).toBe(404);
    expect(mocks.file).toHaveBeenCalledWith("internal", "file"); expect(mocks.response).not.toHaveBeenCalled();
  });
  it("ブラウザの元動画はセッションの clearance で取得する", async () => {
    mocks.auth.mockResolvedValue({ user: { clearance: "public" } }); mocks.source.mockResolvedValue({ storageKey: "drive" });
    mocks.response.mockResolvedValue(new Response(null, { status: 206 }));
    const request = new Request("https://local/media?source=1", { headers: { Authorization: "Bearer ak_test", Range: "bytes=0-1" } });
    expect((await GET(request, context)).status).toBe(206);
    expect(mocks.apiAuth).not.toHaveBeenCalled(); expect(mocks.source).toHaveBeenCalledWith("public", "file");
  });
});
