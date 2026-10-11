import { describe, expect, it } from "vitest";
import { hinaaiEpisodeOf, hinaaiSubtitle, isHinaaiListTitle, isMadamada, listedEpisodes } from "./hinaai";

describe("hinaaiEpisodeOf", () => {
  it("本編もまだまだも回番号を拾う", () => {
    expect(hinaaiEpisodeOf("日向坂で会いましょう【宮崎が似合う女決定戦】#372")).toBe(372);
    expect(hinaaiEpisodeOf("まだまだ！日向坂で会いましょう【まだまだ“運”動会の裏側をお届けしましょう！】#374")).toBe(374);
  });

  it("回番号の無いもの・ほかの番組は null", () => {
    expect(hinaaiEpisodeOf("日向坂で会いましょう スタジオライブ")).toBeNull();
    expect(hinaaiEpisodeOf("日向坂で会いましょう #364 thumbnail [w1]")).toBeNull();
    expect(hinaaiEpisodeOf("ひなた坂46 #12")).toBeNull();
  });
});

describe("題の扱い", () => {
  it("まだまだ・副題・一覧記事", () => {
    expect(isMadamada("まだまだ！日向坂で会いましょう【x】#1")).toBe(true);
    expect(isMadamada("日向坂で会いましょう【x】#1")).toBe(false);
    expect(hinaaiSubtitle("日向坂で会いましょう【宮崎が似合う女決定戦】#372")).toBe("宮崎が似合う女決定戦");
    expect(isHinaaiListTitle("【2年目】日向坂で会いましょう出演一覧")).toBe(true);
    expect(isHinaaiListTitle("日向坂で会いましょう出演一覧")).toBe(true);
    expect(isHinaaiListTitle("ひなあい初登場時の自己紹介")).toBe(false);
  });
});

describe("listedEpisodes", () => {
  it("表の 1 列目の回番号だけを拾う", () => {
    const body = [
      "| #   | 日付 | タイトル |",
      "| --- | --- | --- |",
      "| 355 | 2026/3/16 | [a](https://x) |",
      "| 383 | 2026/10/5 | [b](https://x) |",
      "本文中の 384 は拾わない",
    ].join("\n");
    expect([...listedEpisodes(body)]).toEqual([355, 383]);
  });
});
