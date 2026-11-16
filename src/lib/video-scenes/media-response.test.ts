import { beforeEach, describe, expect, it, vi } from "vitest";
const drive = vi.hoisted(() => ({ downloadRangeFromDrive: vi.fn(), getDriveFileMeta: vi.fn() }));
vi.mock("@/lib/drive", () => drive);
import { sceneMediaResponse } from "./media-response";

beforeEach(() => vi.clearAllMocks());
describe("認証済み動画の応答", () => {
  it("Range と非公開のヘッダを返す", async () => {
    drive.downloadRangeFromDrive.mockResolvedValue({ body: Buffer.alloc(2), total: 100 });
    const response = await sceneMediaResponse(new Request("https://local/media", { headers: { Range: "bytes=-2" } }), { storageKey: "drive", fileSize: 100, mimeType: "video/mp4" });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 98-99/100");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-length")).toBe("2");
  });
  it("Drive が Range を無視して全体を返しても配信しない", async () => {
    drive.downloadRangeFromDrive.mockResolvedValue({ body: Buffer.alloc(100), total: 100 });
    const response = await sceneMediaResponse(new Request("https://local/media", { headers: { Range: "bytes=0-1" } }), { storageKey: "drive", fileSize: 100, mimeType: "video/mp4" });
    expect(response.status).toBe(502);
  });
  it("範囲が不正なら Drive を呼ばない", async () => {
    const response = await sceneMediaResponse(new Request("https://local/media", { headers: { Range: "bytes=100-" } }), { storageKey: "drive", fileSize: 100, mimeType: "video/mp4" });
    expect(response.status).toBe(416);
    expect(drive.downloadRangeFromDrive).not.toHaveBeenCalled();
  });
});
