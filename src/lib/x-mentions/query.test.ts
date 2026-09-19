import { describe, expect, it } from "vitest";
import { X_QUERY_MAX_CHARS, buildMentionQuery, isExcluded, newerTweetId, normalizeUsername, parseUsernames } from "./query";

describe("normalizeUsername", () => {
  it("@ と前後の空白を落として小文字にする", () => {
    expect(normalizeUsername(" @Hinatazaka46 ")).toBe("hinatazaka46");
  });
  it("形が違えば null", () => {
    expect(normalizeUsername("")).toBeNull();
    expect(normalizeUsername("日向坂")).toBeNull();
    expect(normalizeUsername("a".repeat(16))).toBeNull();
  });
});

describe("parseUsernames", () => {
  it("改行・カンマ・読点・空白で区切り、重複を畳む", () => {
    const r = parseUsernames("@a, b\nB、c d");
    expect(r.usernames).toEqual(["a", "b", "c", "d"]);
    expect(r.invalid).toEqual([]);
  });
  it("形が違うものは invalid に分ける", () => {
    const r = parseUsernames("ok 日本語 @also_ok");
    expect(r.usernames).toEqual(["ok", "also_ok"]);
    expect(r.invalid).toEqual(["日本語"]);
  });
});

describe("buildMentionQuery", () => {
  it("-is:retweet と -from: を後ろに足す", () => {
    const r = buildMentionQuery('"坂井新奈"', ["a", "b"]);
    expect(r.query).toBe('"坂井新奈" -is:retweet -from:a -from:b');
    expect(r.excludedInQuery).toEqual(["a", "b"]);
  });
  it("上限に入りきらない -from: は落とし、入った分だけ返す", () => {
    const many = Array.from({ length: 60 }, (_, i) => `user_${String(i).padStart(10, "0")}`); // 15 文字
    const r = buildMentionQuery("にいな", many);
    expect(r.query.length).toBeLessThanOrEqual(X_QUERY_MAX_CHARS);
    expect(r.excludedInQuery.length).toBeGreaterThan(0);
    expect(r.excludedInQuery.length).toBeLessThan(many.length);
    expect(r.query.endsWith(`-from:${r.excludedInQuery.at(-1)}`)).toBe(true);
  });
});

describe("isExcluded", () => {
  it("大文字小文字と @ を無視して突き合わせる", () => {
    expect(isExcluded("@Official", ["official"])).toBe(true);
    expect(isExcluded("someone", ["official"])).toBe(false);
  });
});

describe("newerTweetId", () => {
  it("BigInt で比べる (Number では丸まる桁)", () => {
    expect(newerTweetId("1837000000000000001", "1837000000000000002")).toBe("1837000000000000002");
    expect(newerTweetId("1837000000000000002", "1837000000000000001")).toBe("1837000000000000002");
  });
  it("null や数字でないものは無視する", () => {
    expect(newerTweetId(null, "5")).toBe("5");
    expect(newerTweetId("5", null)).toBe("5");
    expect(newerTweetId("abc", "5")).toBe("5");
    expect(newerTweetId(null, null)).toBeNull();
  });
});
