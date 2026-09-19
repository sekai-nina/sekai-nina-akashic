import { describe, expect, it } from "vitest";

import { parseDossierTitle, parseSingleFromCollectionName } from "./import";

describe("parseDossierTitle", () => {
  it("手作業時代の命名から日付・呼び分け・形式を読む", () => {
    expect(parseDossierTitle("2026-08-01 京都リアミ")).toEqual({
      date: "2026-08-01",
      label: "京都",
      format: "real",
    });
    expect(parseDossierTitle("2026-08-09 通常オンミ")).toEqual({
      date: "2026-08-09",
      label: "通常",
      format: "online",
    });
  });

  it("実データにある呼び分けの揺れを全部拾う", () => {
    // 通常 / 初限 / 全国 / 通常版 / 京都 / 横浜 / 幕張 が実在する
    for (const [title, label] of [
      ["2025-08-02 初限オンミ", "初限"],
      ["2026-07-20 全国オンミ", "全国"],
      ["2026-07-05 通常版オンミ", "通常版"],
      ["2026-02-07 横浜リアミ", "横浜"],
      ["2025-10-19 幕張リアミ", "幕張"],
    ] as const) {
      expect(parseDossierTitle(title)?.label).toBe(label);
    }
  });

  it("呼び分けが無くても読める", () => {
    expect(parseDossierTitle("2026-08-01 リアミ")).toEqual({
      date: "2026-08-01",
      label: "",
      format: "real",
    });
  });

  it("ミーグリ以外のドシエは対象外", () => {
    expect(parseDossierTitle("サッカー観戦")).toBeNull();
    expect(parseDossierTitle("2026-08-01 ライブ")).toBeNull();
    expect(parseDossierTitle("京都リアミ")).toBeNull(); // 日付が無い
  });

  it("暦に無い日付は弾く", () => {
    expect(parseDossierTitle("2026-02-30 通常オンミ")).toBeNull();
    expect(parseDossierTitle("2026-13-01 通常オンミ")).toBeNull();
  });
});

describe("parseSingleFromCollectionName", () => {
  it("記事 frontmatter の表記 (NNthシングル「…」) に揃える", () => {
    // 収集名は『』と「シングル」の有無が揺れている
    expect(parseSingleFromCollectionName("17th『Kind of love』通常オンラインミーグリ 2026年8月9日 坂井新奈")).toBe(
      "17thシングル「Kind of love」"
    );
    expect(
      parseSingleFromCollectionName("16thシングル『クリフハンガー』通常オンラインミーグリ 2026年3月1日 坂井新奈")
    ).toBe("16thシングル「クリフハンガー」");
  });

  it("タイトルに記号が入っていても拾う", () => {
    expect(parseSingleFromCollectionName("15th『お願いバッハ！』京都リアルミーグリ 2025年11月9日")).toBe(
      "15thシングル「お願いバッハ！」"
    );
    expect(parseSingleFromCollectionName("14th『Love yourself!』幕張リアルミーグリ 2025年7月21日")).toBe(
      "14thシングル「Love yourself!」"
    );
  });

  it("シングル名が無ければ空", () => {
    expect(parseSingleFromCollectionName("ミーグリレポ 2026年8月1日")).toBe("");
  });
});
