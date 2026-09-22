import { describe, expect, it } from "vitest";
import {
  TiktokTargetError,
  captionMatches,
  isAllowedCoverUrl,
  normalizeHandle,
  parseCaptionFilter,
  sourceEntityName,
  videoUrl,
} from "@/lib/tiktok/targets";

describe("normalizeHandle", () => {
  it("@ と URL を剥がして小文字にする", () => {
    expect(normalizeHandle("@HinatazakaNews")).toBe("hinatazakanews");
    expect(normalizeHandle("https://www.tiktok.com/@hinatazakanews?lang=ja")).toBe("hinatazakanews");
    expect(normalizeHandle("https://www.tiktok.com/@hinatazakanews/video/1")).toBe("hinatazakanews");
  });
  it("形式が違えば投げる", () => {
    expect(() => normalizeHandle("日向坂")).toThrow(TiktokTargetError);
    expect(() => normalizeHandle("")).toThrow(TiktokTargetError);
    expect(() => normalizeHandle("not!valid")).toThrow(TiktokTargetError);
  });
});

describe("sourceEntityName", () => {
  it("sourceName が空ならハンドルから組む", () => {
    expect(sourceEntityName({ handle: "hinatazakanews", sourceName: "" })).toBe("TikTok @hinatazakanews");
    expect(sourceEntityName({ handle: "hinatazakanews", sourceName: " 日向坂46 TikTok " })).toBe("日向坂46 TikTok");
  });
});

describe("videoUrl", () => {
  it("動画 URL を組む", () => {
    expect(videoUrl("h", "123456")).toBe("https://www.tiktok.com/@h/video/123456");
  });
});

describe("isAllowedCoverUrl", () => {
  it("TikTok の CDN の https だけ許す", () => {
    expect(isAllowedCoverUrl("https://p16-sign-sg.tiktokcdn.com/tos/x.jpeg?x-expires=1")).toBe(true);
    expect(isAllowedCoverUrl("https://p16-common-sign.tiktokcdn-us.com/x.jpeg")).toBe(true);
    expect(isAllowedCoverUrl("https://www.tiktok.com/x.jpeg")).toBe(true);
  });
  it("それ以外は拒む (SSRF)", () => {
    expect(isAllowedCoverUrl("http://p16-sign-sg.tiktokcdn.com/x.jpeg")).toBe(false);
    expect(isAllowedCoverUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isAllowedCoverUrl("https://evil.com/tiktokcdn.com/x.jpeg")).toBe(false);
    expect(isAllowedCoverUrl("https://tiktokcdn.com.evil.com/x.jpeg")).toBe(false);
    expect(isAllowedCoverUrl("not a url")).toBe(false);
  });
});

describe("captionMatches", () => {
  it("空の絞り込みは全部合う", () => {
    expect(parseCaptionFilter("")).toEqual([]);
    expect(captionMatches("なんでも", "")).toBe(true);
  });
  it("| 区切りのいずれかを含めば合う (大文字小文字は区別しない)", () => {
    expect(parseCaptionFilter(" 日向坂 | ひなた |")).toEqual(["日向坂", "ひなた"]);
    expect(captionMatches("#日向坂46 の動画", "日向坂|ひなた")).toBe(true);
    expect(captionMatches("#乃木坂46 の動画", "日向坂|ひなた")).toBe(false);
    expect(captionMatches("Hinatazaka", "hinatazaka")).toBe(true);
  });
});
