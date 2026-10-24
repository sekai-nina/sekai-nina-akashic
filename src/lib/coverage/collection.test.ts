import { describe, expect, it } from "vitest";
import { autoCollectedUntil, heartbeatJobKey, parseCollectedUntil } from "./collection";

describe("手入力の収集済みの日付", () => {
  const now = new Date("2026-10-17T15:00:00.000Z");
  it("JST の今日を DATE として保存できる", () => {
    expect(parseCollectedUntil("2026-10-18", now)?.toISOString()).toBe("2026-10-18T00:00:00.000Z");
    expect(() => parseCollectedUntil("2026-10-18", new Date("2026-10-17T14:59:59.999Z"))).toThrow("今日（JST）以前");
  });
  it("空への変更を未確認として扱う", () => expect(parseCollectedUntil(null, now)).toBeNull());
  it.each(["2026-02-30", "2026/10/01", "1899-12-31", ""])("不正な日付 %s を拒否する", (value) => {
    expect(() => parseCollectedUntil(value, now)).toThrow();
  });
  it("うるう日を許可する", () => expect(parseCollectedUntil("2024-02-29", now)?.getUTCDate()).toBe(29));
});

describe("自動の収集済みの日付", () => {
  it("最終成功を JST の暦日にする", () => {
    expect(autoCollectedUntil(new Date("2026-10-24T14:59:59.999Z"))).toBe("2026-10-24");
    expect(autoCollectedUntil(new Date("2026-10-24T15:00:00.000Z"))).toBe("2026-10-25");
  });
  it("報告が無ければ未確認", () => expect(autoCollectedUntil(null)).toBeNull());
  it("ハートビートの無いソースは手入力", () => {
    expect(heartbeatJobKey("blog")).toBe("bot.blog_watch");
    expect(heartbeatJobKey("magazine")).toBeNull();
  });
});
