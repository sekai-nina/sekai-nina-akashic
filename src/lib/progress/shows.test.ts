import { describe, expect, it } from "vitest";
import { episodeOf, isListTitle, listedEpisodes, SHOWS, subtitleOf } from "./shows";

const { hinaai, hinanari } = SHOWS;

describe("episodeOf", () => {
  it("本編もまだまだも回番号を拾う", () => {
    expect(episodeOf(hinaai, "日向坂で会いましょう【宮崎が似合う女決定戦】#372")).toBe(372);
    expect(episodeOf(hinaai, "まだまだ！日向坂で会いましょう【まだまだ“運”動会の裏側をお届けしましょう！】#374")).toBe(374);
  });

  it("ひななりは #0 から。末尾の改行は許す", () => {
    expect(episodeOf(hinanari, "日向坂になりましょう【初回だよ！】#0")).toBe(0);
    expect(episodeOf(hinanari, "日向坂になりましょう【ザ・ハイテンション番外編】#7\n")).toBe(7);
  });

  it("回番号の無いもの・ほかの番組は null", () => {
    expect(episodeOf(hinaai, "日向坂で会いましょう スタジオライブ")).toBeNull();
    expect(episodeOf(hinaai, "日向坂で会いましょう #364 thumbnail [w1]")).toBeNull();
    expect(episodeOf(hinaai, "日向坂になりましょう【x】#3")).toBeNull();
    expect(episodeOf(hinanari, "日向坂で会いましょう【x】#3")).toBeNull();
  });
});

describe("題の扱い", () => {
  it("まだまだ・番外編・副題・一覧記事", () => {
    expect(hinaai.isExtra("まだまだ！日向坂で会いましょう【x】#1")).toBe(true);
    expect(hinaai.isExtra("日向坂で会いましょう【x】#1")).toBe(false);
    expect(hinanari.isExtra("日向坂になりましょう【ザ・ハイテンション番外編】#7")).toBe(true);
    expect(hinanari.isExtra("日向坂になりましょう【番外編 私もうプロフェッショナルなんです！後半戦】#2")).toBe(true);
    expect(hinanari.isExtra("日向坂になりましょう【ザ・ハイテンション】#7")).toBe(false);
    expect(subtitleOf("日向坂で会いましょう【宮崎が似合う女決定戦】#372")).toBe("宮崎が似合う女決定戦");
    expect(isListTitle(hinaai, "【2年目】日向坂で会いましょう出演一覧")).toBe(true);
    expect(isListTitle(hinaai, "日向坂で会いましょう出演一覧")).toBe(true);
    expect(isListTitle(hinaai, "ひなあい初登場時の自己紹介")).toBe(false);
    expect(isListTitle(hinanari, "【1年目】日向坂になりましょう出演一覧")).toBe(true);
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

  it("番外編の枝番 (1a / 14b) は本編の回に数える", () => {
    const body = ["| 0   | x |", "| 1   | x |", "| 1a  | x |", "| 14b | x |"].join("\n");
    expect([...listedEpisodes(body)]).toEqual([0, 1, 14]);
  });
});
