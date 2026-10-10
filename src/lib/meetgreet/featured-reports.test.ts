import { describe, expect, it } from "vitest";
import { featuredReportUrls, listReportEmbeds, setReportFeatured, tweetIdOf } from "./featured-reports";

const BODY = [
  "## 参加レポ",
  "",
  "ファンのレポ。",
  "",
  "![](https://x.com/aaa/status/111)",
  "![rep](https://x.com/bbb/status/222)",
  "![](https://twitter.com/ccc/status/333?s=20)",
  "",
  "本文中の https://x.com/ddd/status/444 は埋め込みではない",
].join("\n");

describe("listReportEmbeds", () => {
  it("埋め込みを出現順に、rep の有無つきで返す", () => {
    expect(listReportEmbeds(BODY)).toEqual([
      { tweetId: "111", url: "https://x.com/aaa/status/111", featured: false },
      { tweetId: "222", url: "https://x.com/bbb/status/222", featured: true },
      { tweetId: "333", url: "https://twitter.com/ccc/status/333", featured: false },
    ]);
  });
});

describe("setReportFeatured", () => {
  it("![] を ![rep] にする (クエリは残す)", () => {
    const next = setReportFeatured(BODY, "333", true)!;
    expect(next).toContain("![rep](https://twitter.com/ccc/status/333?s=20)");
    expect(next.split("\n").length).toBe(BODY.split("\n").length);
  });
  it("![rep] を ![] に戻す", () => {
    expect(setReportFeatured(BODY, "222", false)).toContain("![](https://x.com/bbb/status/222)");
  });
  it("既にその状態なら本文は変わらない", () => {
    expect(setReportFeatured(BODY, "222", true)).toBe(BODY);
  });
  it("埋め込みに無いツイートは null", () => {
    expect(setReportFeatured(BODY, "444", true)).toBeNull();
  });
});

describe("同じツイートが 2 回あるとき", () => {
  const dup = "![](https://x.com/a/status/9)\n![rep](https://x.com/a/status/9)";
  it("どちらかが rep なら featured として 1 つにまとめる", () => {
    expect(listReportEmbeds(dup)).toEqual([{ tweetId: "9", url: "https://x.com/a/status/9", featured: true }]);
  });
  it("on は最初の 1 つだけ、off はすべて外す", () => {
    expect(setReportFeatured(dup, "9", true)).toBe("![rep](https://x.com/a/status/9)\n![](https://x.com/a/status/9)");
    expect(setReportFeatured(dup, "9", false)).toBe("![](https://x.com/a/status/9)\n![](https://x.com/a/status/9)");
  });
});

describe("featuredReportUrls", () => {
  it("サイトと同じく ![rep] だけを拾う", () => {
    expect(featuredReportUrls(BODY)).toEqual(["https://x.com/bbb/status/222"]);
    expect(featuredReportUrls(setReportFeatured(BODY, "111", true)!)).toEqual([
      "https://x.com/aaa/status/111",
      "https://x.com/bbb/status/222",
    ]);
  });
});

describe("tweetIdOf", () => {
  it("URL からツイート ID を取る", () => {
    expect(tweetIdOf("https://x.com/a/status/123?s=1")).toBe("123");
    expect(tweetIdOf("https://example.com")).toBeNull();
  });
});
