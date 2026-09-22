import { describe, expect, it } from "vitest";

import {
  DISPATCH_TIMEOUT_MS,
  InstaJobError,
  PENDING_TIMEOUT_MS,
  PROCESSING_TIMEOUT_MS,
  buildWorkerInput,
  formatCompletionMessage,
  parseJobResult,
  parseStoryUrl,
  resolveMimeType,
  staleReason,
} from "@/lib/insta/jobs";

describe("parseStoryUrl", () => {
  it("story の URL を正規化する", () => {
    expect(parseStoryUrl("https://www.instagram.com/stories/hinatazaka46/")).toEqual({
      handle: "hinatazaka46",
      url: "https://www.instagram.com/stories/hinatazaka46/",
      storyId: null,
    });
    expect(parseStoryUrl("https://www.instagram.com/stories/HinataZaka46/3712345678901234567/?utm=x")).toEqual({
      handle: "hinatazaka46",
      url: "https://www.instagram.com/stories/hinatazaka46/3712345678901234567/",
      storyId: "3712345678901234567",
    });
    // 末尾スラッシュ無し・www 無し・スキーム無し・http・大文字も拾う
    expect(parseStoryUrl("instagram.com/stories/hinatazaka46").url).toBe(
      "https://www.instagram.com/stories/hinatazaka46/",
    );
    expect(parseStoryUrl("http://instagram.com/stories/hinatazaka46/").url).toBe(
      "https://www.instagram.com/stories/hinatazaka46/",
    );
    expect(parseStoryUrl("HTTPS://WWW.INSTAGRAM.COM/stories/HinataZaka46/").handle).toBe("hinatazaka46");
  });

  it("ハンドルだけなら stories/<handle>/ にする (bot は検知時にハンドルしか持たない)", () => {
    expect(parseStoryUrl("@hinatazaka46")).toEqual({
      handle: "hinatazaka46",
      url: "https://www.instagram.com/stories/hinatazaka46/",
      storyId: null,
    });
  });

  it("instagram.com の story 以外は弾く (iPad に任意の URL を開かせない)", () => {
    expect(() => parseStoryUrl("https://example.com/stories/foo/")).toThrow(InstaJobError);
    expect(() => parseStoryUrl("https://www.instagram.com/p/abc123/")).toThrow(InstaJobError);
    expect(() => parseStoryUrl("https://www.instagram.com/hinatazaka46/")).toThrow(InstaJobError);
    expect(() => parseStoryUrl("https://evil.instagram.com.example/stories/foo/")).toThrow(InstaJobError);
    expect(() => parseStoryUrl("javascript:alert(1)")).toThrow(InstaJobError);
    expect(() => parseStoryUrl("")).toThrow(InstaJobError);
    // ID の後ろに余計なパスが付いているもの
    expect(() => parseStoryUrl("https://www.instagram.com/stories/hinatazaka46/123/extra")).toThrow(InstaJobError);
  });

  it("ハイライトは弾く (stories/highlights/<id>/ の highlights はハンドルではない)", () => {
    expect(() => parseStoryUrl("https://www.instagram.com/stories/highlights/17912345678901234567/")).toThrow(
      /ハイライト/,
    );
  });

  it("ハンドルの形式が不正なら弾く", () => {
    expect(() => parseStoryUrl("https://www.instagram.com/stories/a%20b/")).toThrow(InstaJobError);
  });
});

describe("buildWorkerInput", () => {
  it("iPad に渡す JSON は jobId / url / handle だけ", () => {
    const json = buildWorkerInput({ id: "j1", url: "https://www.instagram.com/stories/x/", handle: "x" });
    expect(JSON.parse(json)).toEqual({ jobId: "j1", url: "https://www.instagram.com/stories/x/", handle: "x" });
  });
});

describe("staleReason", () => {
  const base = new Date("2026-09-22T00:00:00Z");
  const at = (ms: number) => new Date(base.getTime() + ms);

  it("dispatched は 10 分で失効", () => {
    const job = { status: "dispatched" as const, createdAt: base, dispatchedAt: base, startedAt: null };
    expect(staleReason(job, at(DISPATCH_TIMEOUT_MS - 1))).toBeNull();
    expect(staleReason(job, at(DISPATCH_TIMEOUT_MS + 1))).toMatch(/受け取りません/);
    // dispatchedAt が無ければ createdAt から数える
    const noStamp = { ...job, dispatchedAt: null };
    expect(staleReason(noStamp, at(DISPATCH_TIMEOUT_MS + 1))).toMatch(/受け取りません/);
  });

  it("processing は 20 分で失効", () => {
    const job = { status: "processing" as const, createdAt: base, dispatchedAt: base, startedAt: at(60_000) };
    expect(staleReason(job, at(60_000 + PROCESSING_TIMEOUT_MS - 1))).toBeNull();
    expect(staleReason(job, at(60_000 + PROCESSING_TIMEOUT_MS + 1))).toMatch(/完了を報告しません/);
  });

  it("pending は 24 時間で諦める (story が消える)", () => {
    const job = { status: "pending" as const, createdAt: base, dispatchedAt: null, startedAt: null };
    expect(staleReason(job, at(PENDING_TIMEOUT_MS - 1))).toBeNull();
    expect(staleReason(job, at(PENDING_TIMEOUT_MS + 1))).toMatch(/24 時間/);
  });

  it("終わったジョブは失効しない", () => {
    const job = { status: "completed" as const, createdAt: base, dispatchedAt: base, startedAt: base };
    expect(staleReason(job, at(10 * PENDING_TIMEOUT_MS))).toBeNull();
  });
});

describe("resolveMimeType", () => {
  it("octet-stream や空は拡張子から補う (Shortcuts はそう送ってくる)", () => {
    expect(resolveMimeType("application/octet-stream", "IMG_0001.JPG")).toBe("image/jpeg");
    expect(resolveMimeType("", "story.mp4")).toBe("video/mp4");
    expect(resolveMimeType(null, "clip.MOV")).toBe("video/quicktime");
    expect(resolveMimeType("", "a.m4v")).toBe("video/mp4");
    expect(resolveMimeType("", "a.heif")).toBe("image/heif");
    // 拡張子からも分からなければ 415
    expect(() => resolveMimeType("application/octet-stream", "file.bin")).toThrow(InstaJobError);
  });

  it("charset 付きも均す", () => {
    expect(resolveMimeType("image/png; charset=binary", "a.png")).toBe("image/png");
  });

  it("画像・動画以外は 415", () => {
    expect(() => resolveMimeType("text/html", "login.html")).toThrow(InstaJobError);
    expect(() => resolveMimeType("application/json", "x.json")).toThrow(expect.objectContaining({ status: 415 }));
  });
});

describe("parseJobResult", () => {
  it("壊れた JSON でも落とさず空にする", () => {
    expect(parseJobResult(null)).toEqual({ files: [] });
    expect(parseJobResult("x")).toEqual({ files: [] });
    expect(parseJobResult({ files: "no" })).toEqual({ files: [] });
    const ok = { assetId: "a", duplicate: false, filename: "a.jpg", mimeType: "image/jpeg", fileSize: 1 };
    // 画面が触る項目 (mimeType / duplicate / fileSize) が欠けた要素は落とす
    expect(parseJobResult({ files: [{ nope: 1 }, { assetId: "a" }, ok] }).files).toHaveLength(1);
  });
});

describe("formatCompletionMessage", () => {
  const file = (assetId: string, duplicate: boolean) => ({
    assetId,
    duplicate,
    driveFileId: null,
    filename: "a.jpg",
    mimeType: "image/jpeg",
    fileSize: 1,
    sha256: "x",
    receivedAt: "2026-09-22T00:00:00Z",
  });

  it("新規と登録済みの件数を分けて出す", () => {
    const msg = formatCompletionMessage({
      handle: "hinatazaka46",
      url: "https://www.instagram.com/stories/hinatazaka46/",
      files: [file("a", false), file("b", true)],
      assetLinks: ["https://akashic.example/assets/a"],
    });
    expect(msg).toContain("新規 1 件 / 登録済み 1 件");
    expect(msg).toContain("https://www.instagram.com/stories/hinatazaka46/");
    expect(msg).toContain("https://akashic.example/assets/a");
  });

  it("登録済みが無ければその数字は出さない", () => {
    const msg = formatCompletionMessage({ handle: "h", url: "u", files: [file("a", false)], assetLinks: [] });
    expect(msg).toContain("新規 1 件)");
    expect(msg).not.toContain("登録済み");
  });

  it("全部登録済みならその旨だけ", () => {
    const msg = formatCompletionMessage({
      handle: "h",
      url: "u",
      files: [file("a", true)],
      assetLinks: [],
    });
    expect(msg).toContain("新しいコマはありませんでした");
  });
});
