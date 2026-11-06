import { describe, expect, it } from "vitest";
import { adjacentTalkDays, isTalkDayKey, isWholeMessageItem, nextUnfinishedTalkDay, talkSpeaker, talkThread } from "./talk-day";

describe("isTalkDayKey", () => {
  it("実在する日付だけを通す", () => {
    expect(isTalkDayKey("2026-11-05")).toBe(true);
    expect(isTalkDayKey("2026-02-30")).toBe(false);
    expect(isTalkDayKey("2026-11-5")).toBe(false);
  });
});

describe("isWholeMessageItem", () => {
  it("本文全体の抜粋は全体、一部の抜粋は全体でない", () => {
    expect(isWholeMessageItem("おはよう\n", { excerpt: "おはよう", note: "" })).toBe(true);
    expect(isWholeMessageItem("おはよう", { excerpt: "おは", note: "" })).toBe(false);
  });

  it("本文のあるメッセージのメモだけの行は全体でない", () => {
    expect(isWholeMessageItem("おはよう", { excerpt: "", note: "メモ" })).toBe(false);
    expect(isWholeMessageItem("おはよう", { excerpt: "", note: "" })).toBe(true);
    expect(isWholeMessageItem("", { excerpt: "", note: "メモ" })).toBe(true);
  });
});

describe("talkSpeaker", () => {
  it("タイトルから話し手を取る", () => {
    expect(talkSpeaker("大田美月トーク 2026.11.5 7:06")).toBe("大田美月");
    expect(talkSpeaker("別のタイトル")).toBeNull();
  });
});

describe("adjacentTalkDays", () => {
  it("抜けのある日付でも隣の日を返す", () => {
    expect(adjacentTalkDays(["2026-11-05", "2026-11-01", "2026-11-03"], "2026-11-03"))
      .toEqual({ newer: "2026-11-05", older: "2026-11-01" });
    expect(adjacentTalkDays(["2026-11-05"], "2026-11-05")).toEqual({ newer: null, older: null });
  });
});

describe("nextUnfinishedTalkDay", () => {
  it("今の日より古く、済でない最も新しい日を返す", () => {
    const days = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"];
    expect(nextUnfinishedTalkDay(days, new Set(["2026-11-02"]), "2026-11-03")).toBe("2026-11-01");
    expect(nextUnfinishedTalkDay(days, new Set(["2026-11-01"]), "2026-11-02")).toBeNull();
  });
});

describe("talkThread", () => {
  const ordered = [
    { assetId: "a", speaker: "A" }, { assetId: "n", speaker: "新奈" }, { assetId: "b", speaker: "A" },
    { assetId: "c", speaker: "A" }, { assetId: "m", speaker: "B" }, { assetId: "d", speaker: "A" },
  ];

  it("同じ話し手の前後だけを時刻順で返す", () => {
    const thread = talkThread(ordered, "c");
    expect(thread.before.map((m) => m.assetId)).toEqual(["a", "b"]);
    expect(thread.after.map((m) => m.assetId)).toEqual(["d"]);
  });

  it("見つからなければ空", () => {
    expect(talkThread(ordered, "x")).toEqual({ before: [], after: [] });
  });
});
