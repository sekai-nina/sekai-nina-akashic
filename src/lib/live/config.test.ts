import { describe, expect, it } from "vitest";

import { joinSongs, liveKeywords, liveReportTagGroups, splitSongs } from "./config";

describe("splitSongs / joinSongs", () => {
  it("スラッシュ区切りを分割し、空と重複を落とす", () => {
    expect(splitSongs("ジャーマンアイリス / キュン /  / キュン")).toEqual(["ジャーマンアイリス", "キュン"]);
  });

  it("全角スラッシュと詰めた書き方も受ける", () => {
    expect(splitSongs("青春の馬／One choice/君はハニーデュー")).toEqual([
      "青春の馬",
      "One choice",
      "君はハニーデュー",
    ]);
  });

  it("読点では割らない (曲名に入りうる)", () => {
    expect(splitSongs("ってか / こんなに好きになっちゃっていいの？、本当")).toEqual([
      "ってか",
      "こんなに好きになっちゃっていいの？、本当",
    ]);
  });

  it("空文字は空配列、往復で同じ文字列に戻る", () => {
    expect(splitSongs("")).toEqual([]);
    const list = ["NO WAR in the future 2020", "キツネ", "空飛ぶ車"];
    expect(splitSongs(joinSongs(list))).toEqual(list);
  });
});

describe("liveKeywords", () => {
  it("ライブ名・鍵括弧の中・会場名 (括弧の前も) をキーワードに足す", () => {
    const kw = liveKeywords({
      name: "日向坂46 ARENA TOUR 2025「MONSTER GROOVE」",
      venues: ["セキスイハイムスーパーアリーナ（宮城）", ""],
    });
    expect(kw).toContain("ライブ");
    expect(kw).toContain("日向坂46 ARENA TOUR 2025「MONSTER GROOVE」");
    expect(kw).toContain("MONSTER GROOVE");
    expect(kw).toContain("セキスイハイムスーパーアリーナ（宮城）");
    expect(kw).toContain("セキスイハイムスーパーアリーナ");
    expect(kw).not.toContain("");
  });

  it("1 文字の断片は入れない (何にでも当たる)", () => {
    const kw = liveKeywords({ name: "「A」", venues: ["B"] });
    expect(kw).not.toContain("A");
    expect(kw).not.toContain("B");
  });
});

describe("liveReportTagGroups", () => {
  it("坂井新奈 AND 各タグ、タグ間は OR (= グループを分ける)", () => {
    expect(liveReportTagGroups(["#MONSTER_GROOVE", "日向坂46宮城公演", " "])).toEqual([
      { tags: ["坂井新奈", "MONSTER_GROOVE"], op: "and" },
      { tags: ["坂井新奈", "日向坂46宮城公演"], op: "and" },
    ]);
  });

  it("タグが無ければ坂井新奈だけ", () => {
    expect(liveReportTagGroups([])).toEqual([{ tags: ["坂井新奈"], op: "and" }]);
  });
});
