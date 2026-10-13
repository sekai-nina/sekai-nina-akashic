import { describe, expect, it } from "vitest";
import { insertListRow, mdDate, nextSuffix, pickYearArticle, tableColumns, type ListRowInput } from "./list-row";

const HINAAI = [
  "坂井新奈が出演した一覧。",
  "",
  "| #   | 日付        | タイトル | 言動  | 補足 |",
  "| --- | --------- | ---- | :-: | --- |",
  "| 355 | 2026/3/16 | [a](https://x/a) |  ○  | x |",
  "| 383 | 2026/10/5 | [b](https://x/b) | — |  |",
  "",
  "---",
  "",
  "1年目はこちら：[[【1年目】日向坂で会いましょう出演一覧]]",
].join("\n");

const row = (over: Partial<ListRowInput> = {}): ListRowInput => ({
  episode: 370,
  suffix: "",
  date: "2026-07-06",
  title: "なんでもランキング",
  url: "https://lemino.example/370",
  cells: { 言動: "○", 補足: "1行目\n2行目" },
  ...over,
});

describe("insertListRow", () => {
  it("回番号順に挿入し、列は見出しから決める", () => {
    const out = insertListRow(HINAAI, row()).split("\n");
    expect(out[5]).toBe("| 370 | 2026/7/6 | [なんでもランキング](https://lemino.example/370) | ○ | 1行目<br>2行目 |");
    expect(out[4]).toContain("| 355 |");
    expect(out[6]).toContain("| 383 |");
  });

  it("最後の回は表の末尾 (表の後ろの本文より前) に足す", () => {
    const out = insertListRow(HINAAI, row({ episode: 384 })).split("\n");
    expect(out[6]).toContain("| 384 |");
    expect(out[7]).toBe("");
  });

  it("空の表 (見出しと区切りだけ) にも足せる", () => {
    const body = "説明\n\n| # | 日付 | タイトル | 言動 | 補足 |\n| --- | --- | --- | :-: | --- |\n";
    expect(insertListRow(body, row({ url: null, cells: { 言動: "—" } }))).toBe(
      "説明\n\n| # | 日付 | タイトル | 言動 | 補足 |\n| --- | --- | --- | :-: | --- |\n| 370 | 2026/7/6 | なんでもランキング | — |  |\n"
    );
  });

  it("ひななりはゲスト列。番外編は枝番で本編の直後", () => {
    const body = ["| # | 配信日 | タイトル | ゲスト |", "| --- | --- | --- | --- |", "| 20 | 2026/4/6 | [a](u) | さや香 |", "| 21 | 2026/4/20 | [b](u) | 水田信二 |"].join("\n");
    const out = insertListRow(body, row({ episode: 20, suffix: "a", date: "2026-04-13", title: "番外編", url: "u2", cells: { ゲスト: "さや香" } })).split("\n");
    expect(out[3]).toBe("| 20a | 2026/4/13 | [番外編](u2) | さや香 |");
    expect(out[4]).toContain("| 21 |");
  });

  it("同じ行があれば投げる・表が無ければ投げる", () => {
    expect(() => insertListRow(HINAAI, row({ episode: 383 }))).toThrow("既に");
    expect(() => insertListRow("本文だけ", row())).toThrow("表が見つかりません");
  });

  it("セルの | とリンク文字の [] をエスケープする", () => {
    const out = insertListRow(HINAAI, row({ title: "[特別] A|B", cells: { 補足: "x|y" } }));
    expect(out).toContain("| 370 | 2026/7/6 | [\\[特別\\] A\\|B](https://lemino.example/370) |  | x\\|y |");
  });
});

describe("表の範囲", () => {
  it("最初の表の外の `| 1 |` は数えず、回番号の無い行で順序を崩さない", () => {
    const body = ["| # | 日付 | タイトル |", "| - | - | - |", "| 10 | 2026/1/1 | a |", "| 合計 | | |", "", "| 5 | x | y |"].join("\n");
    expect(nextSuffix(body, 5, false)).toBe("");
    const out = insertListRow(body, row({ episode: 11, cells: {} })).split("\n");
    expect(out[3]).toContain("| 11 |");
    expect(out[4]).toBe("| 合計 | | |");
  });

  it("リンク先の括弧と空白はエンコードする", () => {
    const body = "| # | タイトル |\n| - | - |\n";
    expect(insertListRow(body, row({ url: "https://x/a (b)" }))).toContain("[なんでもランキング](https://x/a%20%28b%29)");
  });
});

describe("nextSuffix", () => {
  const body = "| # | x |\n| --- | --- |\n| 20 | a |\n| 20a | b |";
  it("本編は行が無ければ空、あれば null。番外編は次の枝番", () => {
    expect(nextSuffix(body, 21, false)).toBe("");
    expect(nextSuffix(body, 20, false)).toBeNull();
    expect(nextSuffix(body, 20, true)).toBe("b");
    expect(nextSuffix(body, 21, true)).toBe("a");
  });
});

describe("pickYearArticle", () => {
  const y1 = { title: "【1年目】日向坂で会いましょう出演一覧", body: "| # | x |\n| --- | --- |\n| 309 | a |\n| 354 | a |" };
  const y2 = { title: "【2年目】日向坂で会いましょう出演一覧", body: "| # | x |\n| --- | --- |\n| 355 | a |\n| 383 | a |" };
  const y3empty = { title: "【3年目】日向坂で会いましょう出演一覧", body: "| # | x |\n| --- | --- |\n" };

  it("開始の回番号が num 以下で最大の記事", () => {
    expect(pickYearArticle([y1, y2], 320)).toBe(0);
    expect(pickYearArticle([y1, y2], 384)).toBe(1);
    expect(pickYearArticle([y2, y1], 355)).toBe(0);
  });

  it("最新年度が空なら、既存の最大を超える回はそこへ", () => {
    expect(pickYearArticle([y1, y2, y3empty], 400)).toBe(2);
    expect(pickYearArticle([y1, y2, y3empty], 370)).toBe(1);
  });

  it("どの記事の開始より前の回は最も古い年度へ", () => {
    expect(pickYearArticle([y2, y1], 300)).toBe(1);
  });

  it("記事が空の 1 本だけならそこ", () => {
    expect(pickYearArticle([y3empty], 371)).toBe(0);
  });

  it("記事が無ければ投げる", () => {
    expect(() => pickYearArticle([], 1)).toThrow();
  });
});

describe("tableColumns / mdDate", () => {
  it("見出しの列名", () => {
    expect(tableColumns(HINAAI)).toEqual(["#", "日付", "タイトル", "言動", "補足"]);
    expect(tableColumns("表なし")).toBeNull();
  });
  it("ゼロ埋めしない", () => {
    expect(mdDate("2026-01-05")).toBe("2026/1/5");
  });
});
