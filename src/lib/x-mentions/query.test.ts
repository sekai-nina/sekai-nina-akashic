import { describe, expect, it } from "vitest";
import {
  WATCH_QUERY_MAX_CHARS,
  X_QUERY_MAX_CHARS,
  buildMentionQuery,
  isExcluded,
  newerTweetId,
  normalizeUsername,
  normalizeWatchQuery,
  parseUsernames,
  tweetIdTimestampMs,
} from "./query";
import { formatHitMessage } from "./run";

describe("normalizeUsername", () => {
  it("@ (全角も) と前後の空白を落として小文字にする", () => {
    expect(normalizeUsername(" @Hinatazaka46 ")).toBe("hinatazaka46");
    expect(normalizeUsername("＠Hinatazaka46")).toBe("hinatazaka46");
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

describe("normalizeWatchQuery", () => {
  it("連続空白を 1 つに畳む", () => {
    expect(normalizeWatchQuery('  "坂井新奈"   -日向坂46 ')).toBe('"坂井新奈" -日向坂46');
  });
  it("空と長すぎるものは弾く", () => {
    expect(() => normalizeWatchQuery("   ")).toThrow();
    expect(() => normalizeWatchQuery("a".repeat(WATCH_QUERY_MAX_CHARS + 1))).toThrow();
  });
});

describe("buildMentionQuery", () => {
  it("監視語を括弧で包み、-is:retweet と -from: を後ろに足す", () => {
    const r = buildMentionQuery('"坂井新奈"', ["a", "b"]);
    expect(r.query).toBe('("坂井新奈") -is:retweet -from:a -from:b');
    expect(r.excludedInQuery).toEqual(["a", "b"]);
  });
  it("OR を含む監視語でも -is:retweet が全体に掛かる (AND が OR より強いため)", () => {
    const r = buildMentionQuery("にいなちゃん OR にーなちゃん", []);
    expect(r.query).toBe("(にいなちゃん OR にーなちゃん) -is:retweet");
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

describe("tweetIdTimestampMs", () => {
  it("snowflake から投稿時刻を出す", () => {
    // 1837000000000000000 = 2024-09-20 頃 (X の ID の上位ビットは 2010-11-04 からのミリ秒)
    const ms = tweetIdTimestampMs("1837000000000000000");
    expect(ms).not.toBeNull();
    expect(new Date(ms!).toISOString().slice(0, 7)).toBe("2024-09");
  });
  it("数字でないものは null", () => {
    expect(tweetIdTimestampMs(null)).toBeNull();
    expect(tweetIdTimestampMs("abc")).toBeNull();
  });
});

describe("formatHitMessage", () => {
  const hit = {
    authorUsername: "someone",
    authorName: "だれか",
    text: "坂井新奈ちゃん\n\nかわいい",
    tweetedAt: new Date("2026-09-20T00:12:00Z"),
    url: "https://x.com/someone/status/1",
  };
  it("監視語・投稿者・JST の時刻・本文 (改行は畳む)・URL を並べる", () => {
    const m = formatHitMessage(hit, ['"坂井新奈"']);
    expect(m.split("\n")).toEqual([
      '🔎 **"坂井新奈"** — だれか (@someone)　2026/09/20 09:12',
      "> 坂井新奈ちゃん かわいい",
      "https://x.com/someone/status/1",
    ]);
  });
  it("表示名や時刻が無くても崩れず、長い本文は切る", () => {
    const m = formatHitMessage({ ...hit, authorName: "", tweetedAt: null, text: "あ".repeat(400) }, ["A", "B"]);
    const lines = m.split("\n");
    expect(lines[0]).toBe("🔎 **A / B** — @someone");
    expect(lines[1]).toBe(`> ${"あ".repeat(280)}…`);
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
