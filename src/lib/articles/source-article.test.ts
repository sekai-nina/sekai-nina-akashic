import { describe, expect, it } from "vitest";
import { articleSourceUrl, parseReservedArticleSources, shortIdFromArticleSourceUrl } from "./source-article";

describe("articleSourceUrl / shortIdFromArticleSourceUrl", () => {
  it("往復する", () => {
    expect(shortIdFromArticleSourceUrl(articleSourceUrl("LNzRI20"))).toBe("LNzRI20");
  });
  it("記事出典の形でなければ null", () => {
    expect(shortIdFromArticleSourceUrl("https://example.com/articles/LNzRI20")).toBeNull();
    expect(shortIdFromArticleSourceUrl("/articles/short")).toBeNull();
    expect(shortIdFromArticleSourceUrl("/articles/LNzRI20/x")).toBeNull();
    expect(shortIdFromArticleSourceUrl(null)).toBeNull();
  });
});

describe("parseReservedArticleSources", () => {
  it("空は空配列", () => {
    expect(parseReservedArticleSources(null)).toEqual([]);
    expect(parseReservedArticleSources("")).toEqual([]);
    expect(parseReservedArticleSources("[]")).toEqual([]);
  });
  it("正しい形を通す", () => {
    expect(parseReservedArticleSources('[{"shortId":"LNzRI20","sourceNo":4}]')).toEqual([
      { shortId: "LNzRI20", sourceNo: 4 },
    ]);
  });
  it("壊れた形・番号の重複・不正な番号は null", () => {
    expect(parseReservedArticleSources("{")).toBeNull();
    expect(parseReservedArticleSources('{"shortId":"LNzRI20"}')).toBeNull();
    expect(parseReservedArticleSources('[{"shortId":"x","sourceNo":1}]')).toBeNull();
    expect(parseReservedArticleSources('[{"shortId":"LNzRI20","sourceNo":0}]')).toBeNull();
    expect(parseReservedArticleSources('[{"shortId":"LNzRI20","sourceNo":1.5}]')).toBeNull();
    expect(
      parseReservedArticleSources('[{"shortId":"LNzRI20","sourceNo":2},{"shortId":"psPHuld","sourceNo":2}]'),
    ).toBeNull();
  });
});
