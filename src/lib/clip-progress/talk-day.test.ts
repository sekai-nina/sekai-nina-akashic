import { describe, expect, it } from "vitest";
import { adjacentTalkDays, isMessageClipped, isTalkDayKey, talkDaysBounds, isWholeMessageItem, nextUnfinishedTalkDay, talkSpeaker, talkThread } from "./talk-day";

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

describe("isMessageClipped", () => {
  it("企画に素材として入れただけの行はクリップ済にしない", () => {
    expect(isMessageClipped("おはよう", { excerpt: "", note: "", inPool: false })).toBe(false);
    expect(isMessageClipped("", { excerpt: "", note: "", inPool: false })).toBe(false);
  });

  it("クリップから企画へ移した本文全体の行はクリップ済のまま", () => {
    expect(isMessageClipped("おはよう", { excerpt: "おはよう", note: "", inPool: false })).toBe(true);
    expect(isMessageClipped("おはよう", { excerpt: "おは", note: "", inPool: false })).toBe(false);
  });

  it("プールの行は本文の無いメッセージでもクリップ済にする", () => {
    expect(isMessageClipped("", { excerpt: "", note: "", inPool: true })).toBe(true);
    expect(isMessageClipped("おはよう", { excerpt: "おはよう", note: "", inPool: true })).toBe(true);
  });
});

describe("talkDaysBounds", () => {
  it("JST の 0 時から最後の日の翌 0 時までを UTC で返す", () => {
    expect(talkDaysBounds(["2026-11-02", "2026-11-01"])).toEqual({
      start: new Date("2026-10-31T15:00:00.000Z"),
      end: new Date("2026-11-02T15:00:00.000Z"),
    });
  });

  it("形式の違うキーは無視し、残らなければ null", () => {
    expect(talkDaysBounds(["bad", "2026-11-01"])?.end).toEqual(new Date("2026-11-01T15:00:00.000Z"));
    expect(talkDaysBounds(["bad"])).toBeNull();
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
