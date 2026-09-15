import { describe, expect, it } from "vitest";

import { formatDate, jstDayString } from "./utils";

/**
 * 日付の表示と比較は **JST 固定**。
 *
 * ここが TZ に依存すると、ローカル (Mac / JST) では正しく見えて Vercel (UTC)
 * だけ 1 日ずれる、という気づきにくいバグになる。以下のテストはランナーの
 * TZ に関係なく同じ結果になることを担保する。
 */

describe("formatDate", () => {
  it("JST 深夜に格納された日付を正しい日として表示する", () => {
    // Asset.canonicalDate は日付のみの値を JST 深夜 = 15:00 UTC 前日で持つ。
    // timeZone を指定しないと UTC 環境で 03/13 になる
    expect(formatDate(new Date("2026-03-13T15:00:00.000Z"))).toBe("2026/03/14");
  });

  it("UTC 深夜に格納された日付を正しい日として表示する", () => {
    // Article.date / ArticleSource.date は UTC 深夜
    expect(formatDate(new Date("2026-03-14T00:00:00.000Z"))).toBe("2026/03/14");
  });

  it("JST の日付境界をまたぐ時刻を JST の日で表示する", () => {
    // 15:00 UTC = 翌日 00:00 JST
    expect(formatDate(new Date("2026-03-13T14:59:59.000Z"))).toBe("2026/03/13");
    expect(formatDate(new Date("2026-03-13T15:00:00.000Z"))).toBe("2026/03/14");
  });

  it("時刻つきでも JST の壁時計で表示する", () => {
    expect(formatDate(new Date("2026-03-13T15:00:00.000Z"), true)).toBe("2026/03/14 00:00");
  });

  it("文字列も受ける", () => {
    expect(formatDate("2026-03-13T15:00:00.000Z")).toBe("2026/03/14");
  });

  it("null / 不正値は空文字", () => {
    expect(formatDate(null)).toBe("");
    expect(formatDate("これは日付ではない")).toBe("");
  });
});

describe("jstDayString", () => {
  it("JST 深夜格納の値を JST の日にする", () => {
    expect(jstDayString(new Date("2026-03-13T15:00:00.000Z"))).toBe("2026-03-14");
  });

  it("UTC 深夜格納の値を JST の日にする", () => {
    expect(jstDayString(new Date("2026-03-14T00:00:00.000Z"))).toBe("2026-03-14");
  });

  it("2 つの格納規約が同じ日として一致する", () => {
    // これが揃わないと出典の日付照合が常に 1 日ずれる
    const asset = new Date("2026-03-13T15:00:00.000Z"); // Asset.canonicalDate
    const article = new Date("2026-03-14T00:00:00.000Z"); // ArticleSource.date
    expect(jstDayString(asset)).toBe(jstDayString(article));
  });
});
