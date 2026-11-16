import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSceneDownload } from "./download";

afterEach(() => vi.unstubAllGlobals());
describe("選んだ動画の保存", () => {
  it("範囲を検証して複数の応答を順につなぎ、元動画は取得しない", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/video-scenes/media/chosen");
      const range = (init.headers as Record<string, string>).Range;
      const start = range === "bytes=0-3999999" ? 0 : 4_000_000;
      const end = start ? 4_000_002 : 3_999_999;
      return new Response(new Uint8Array(end - start + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/4000003` } });
    });
    vi.stubGlobal("fetch", fetch);
    const progress = vi.fn();
    const blob = await fetchSceneDownload({ id: "chosen", kind: "video", fileSize: 4_000_003, mimeType: "video/mp4" }, new AbortController().signal, progress);
    expect(blob.size).toBe(4_000_003);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenLastCalledWith(100);
  });
  it("ログイン画面や途中から別の範囲になった応答を保存しない", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("login", { status: 200 })));
    await expect(fetchSceneDownload({ id: "x", kind: "video", fileSize: 100, mimeType: "video/mp4" }, new AbortController().signal, () => {})).rejects.toThrow();
  });
  it("取得前に容量の上限を確認する", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(fetchSceneDownload({ id: "x", kind: "video", fileSize: 100_000_001, mimeType: "video/mp4" }, new AbortController().signal, () => {})).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
