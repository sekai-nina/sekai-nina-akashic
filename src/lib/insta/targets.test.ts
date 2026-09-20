import { describe, expect, it } from "vitest";

import { HANDLE_PATTERN, InstaTargetError, TIER_DEFAULT_MINUTES, normalizeHandle } from "@/lib/insta/targets";

describe("normalizeHandle", () => {
  it("@ や URL を貼られても拾う", () => {
    expect(normalizeHandle("@hiyotan928_official")).toBe("hiyotan928_official");
    expect(normalizeHandle("https://www.instagram.com/hinatazaka46/")).toBe("hinatazaka46");
    expect(normalizeHandle("instagram.com/foo?hl=ja".replace(/^/, "https://"))).toBe("foo");
  });

  it("大文字と前後の空白を均す", () => {
    expect(normalizeHandle("  HinataZaka46 ")).toBe("hinatazaka46");
  });

  it("形式が不正なら弾く", () => {
    // 空・記号・長すぎるものを通すと、そのまま URL に埋め込まれて 404 を叩き続ける
    expect(() => normalizeHandle("")).toThrow(InstaTargetError);
    expect(() => normalizeHandle("a b")).toThrow(InstaTargetError);
    expect(() => normalizeHandle("a".repeat(31))).toThrow(InstaTargetError);
  });
});

describe("TIER_DEFAULT_MINUTES", () => {
  it("bot 側の既定と揃っている", () => {
    expect(TIER_DEFAULT_MINUTES.hot).toBe(10);
    expect(TIER_DEFAULT_MINUTES.normal).toBe(18);
    expect(TIER_DEFAULT_MINUTES.cold).toBe(240);
  });

  it("HANDLE_PATTERN は小文字・数字・._ のみ", () => {
    expect(HANDLE_PATTERN.test("a.b_c1")).toBe(true);
    expect(HANDLE_PATTERN.test("Abc")).toBe(false);
  });
});
