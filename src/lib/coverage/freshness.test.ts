import { describe, expect, it } from "vitest";
import { legacyConfirmedUntil, parseConfirmedUntil } from "./freshness";

describe("公開鮮度の日付", () => {
  const now = new Date("2026-10-17T15:00:00.000Z");
  it("JST の今日を DATE として保存できる", () => {
    expect(parseConfirmedUntil("2026-10-18", now)?.toISOString()).toBe("2026-10-18T00:00:00.000Z");
    expect(() => parseConfirmedUntil("2026-10-18", new Date("2026-10-17T14:59:59.999Z"))).toThrow("今日（JST）以前");
  });
  it("空への変更を明示的な未確認として扱う", () => expect(parseConfirmedUntil(null, now)).toBeNull());
  it.each(["", "2026-2-3", "2026-02-30", "2025-02-29", "2026-13-01", "1899-12-31", "2026-10-19", "2026-10-17T00:00:00Z"])("無効または未来の日付 %s を拒否する", (value) => {
    expect(() => parseConfirmedUntil(value, now)).toThrow();
  });
  it("うるう日を許可する", () => expect(parseConfirmedUntil("2024-02-29", now)?.getUTCDate()).toBe(29));
});

describe("旧チェックからの日付表示", () => {
  const item = (itemKey: string, day: string | null) => ({ itemKey, itemDate: day ? new Date(`${day}T00:00:00Z`) : null });
  const items = [item("day1", "2026-10-01"), item("day2a", "2026-10-02"), item("day2b", "2026-10-02"), item("day3", "2026-10-03")];
  it("同日に未チェックが一つでもあれば前の日付までとする", () => {
    expect(legacyConfirmedUntil(items, new Set(["day1", "day2a", "day3"]))).toBe("2026-10-01");
    expect(legacyConfirmedUntil(items.slice().reverse(), new Set(["day1", "day2b", "day3"]))).toBe("2026-10-01");
  });
  it("全件確認済みなら最後の素材の日付までとする", () => expect(legacyConfirmedUntil(items, new Set(items.map((i) => i.itemKey)))).toBe("2026-10-03"));
  it("先頭が未確認なら null。消えたキーや日付なしは日付を進めない", () => {
    expect(legacyConfirmedUntil(items, new Set(["day2a", "day2b", "day3"]))).toBeNull();
    expect(legacyConfirmedUntil([item("undated", null)], new Set(["undated", "deleted"]))).toBeNull();
    expect(legacyConfirmedUntil(items)).toBeNull();
  });
});
