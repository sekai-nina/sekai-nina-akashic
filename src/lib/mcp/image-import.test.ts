import { describe, expect, it } from "vitest";
import { filenameFromUrl, imageTypeOf, toHeaderSafeUrl } from "./image-import";

const SHA = "0123456789abcdef".repeat(4);

describe("imageTypeOf", () => {
  it("主な形式を MIME と拡張子にする", () => {
    expect(imageTypeOf({ format: "jpeg" })).toEqual({ mimeType: "image/jpeg", ext: "jpg" });
    expect(imageTypeOf({ format: "png" })).toEqual({ mimeType: "image/png", ext: "png" });
  });

  it("heif は圧縮方式で AVIF と HEIC を見分ける", () => {
    expect(imageTypeOf({ format: "heif", compression: "av1" })?.mimeType).toBe("image/avif");
    expect(imageTypeOf({ format: "heif", compression: "hevc" })?.mimeType).toBe("image/heic");
  });

  it("SVG などは受けない", () => {
    expect(imageTypeOf({ format: "svg" })).toBeNull();
    expect(imageTypeOf({ format: "raw" } as never)).toBeNull();
  });
});

describe("filenameFromUrl", () => {
  it("URL の末尾を使い、拡張子は中身に合わせる", () => {
    expect(filenameFromUrl("https://example.com/img/photo01.png?x=1", "jpg", SHA)).toBe("photo01.jpg");
  });

  it("エスケープされた日本語を戻す", () => {
    expect(filenameFromUrl("https://example.com/%E6%96%B0%E5%A5%88.jpg", "jpg", SHA)).toBe("新奈.jpg");
  });

  it("名前が取れなければ sha256 の先頭を使う", () => {
    expect(filenameFromUrl("https://example.com/", "webp", SHA)).toBe(`${SHA.slice(0, 16)}.webp`);
    expect(filenameFromUrl("https://example.com/..", "jpg", SHA)).toBe(`${SHA.slice(0, 16)}.jpg`);
    expect(filenameFromUrl("https://example.com/%E0%A4%A.jpg", "jpg", SHA)).toBe(`${SHA.slice(0, 16)}.jpg`);
  });

  it("ファイル名に使えない文字を置き換え、文字単位で切る", () => {
    expect(filenameFromUrl("https://example.com/a%3Ab%22c.jpg", "jpg", SHA)).toBe("a_b_c.jpg");
    const long = "😀".repeat(150);
    const name = filenameFromUrl(`https://example.com/${encodeURIComponent(long)}.jpg`, "jpg", SHA);
    expect(Array.from(name.replace(/\.jpg$/, ""))).toHaveLength(100);
    expect(name.isWellFormed()).toBe(true);
  });
});

describe("toHeaderSafeUrl", () => {
  it("日本語の URL はエスケープして返す", () => {
    expect(toHeaderSafeUrl("https://ja.wikipedia.org/wiki/坂井新奈")).toBe(
      "https://ja.wikipedia.org/wiki/%E5%9D%82%E4%BA%95%E6%96%B0%E5%A5%88"
    );
  });

  it("URL でなければ null", () => {
    expect(toHeaderSafeUrl("not a url")).toBeNull();
  });
});
