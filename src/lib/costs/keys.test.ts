import { describe, expect, it } from "vitest";

import { FEATURE_PATTERN, makeFeatureResolver, readKeyFeatureMap, toFeatureName } from "./keys";

describe("toFeatureName", () => {
  it("小文字にして使えない文字を潰す", () => {
    expect(toFeatureName("openai", "Bot (prod)")).toBe("openai:bot-prod");
    expect(toFeatureName("openai", "今日の発見")).toBe("openai:unknown");
    expect(toFeatureName("anthropic", "nitan_discord")).toBe("anthropic:nitan_discord");
  });

  it("FEATURE_PATTERN に収まる (API と同じ形)", () => {
    for (const raw of ["Bot (prod)", "key１", "  spaced  name  ", "a".repeat(200)]) {
      const name = toFeatureName("openai", raw);
      expect(name.length).toBeLessThanOrEqual(64);
      expect(FEATURE_PATTERN.test(name)).toBe(true);
    }
  });

  it("空になる名前は unknown に倒す (空文字を作らない)", () => {
    expect(toFeatureName("openai", "---")).toBe("openai:unknown");
    expect(toFeatureName("openai", "")).toBe("openai:unknown");
  });
});

describe("readKeyFeatureMap", () => {
  it("JSON を読んでキーを小文字化する", () => {
    expect(readKeyFeatureMap('{"KEY_ABC":"bot.discovery"}', "X")).toEqual({ key_abc: "bot.discovery" });
  });

  it("壊れていても落とさず空を返す", () => {
    expect(readKeyFeatureMap("{", "X")).toEqual({});
    expect(readKeyFeatureMap("[1,2]", "X")).toEqual({});
    expect(readKeyFeatureMap(undefined, "X")).toEqual({});
  });

  it("値が文字列でないものは捨てる", () => {
    expect(readKeyFeatureMap('{"a":1,"b":"ok","c":"  "}', "X")).toEqual({ b: "ok" });
  });
});

describe("makeFeatureResolver", () => {
  const names = new Map([["key_abc", "bot"]]);

  it("環境変数の対応表が最優先", () => {
    const r = makeFeatureResolver("openai", { key_abc: "bot.discovery" }, names);
    expect(r("key_abc")).toBe("bot.discovery");
  });

  it("対応表に無ければプロバイダのキー名を使う", () => {
    const r = makeFeatureResolver("openai", {}, names);
    expect(r("key_abc")).toBe("openai:bot");
  });

  it("キー名も引けなければキー ID をそのまま出す (黙って落とさない)", () => {
    const r = makeFeatureResolver("openai", {}, new Map());
    expect(r("key_XYZ")).toBe("openai:key_xyz");
  });

  it("キーの指定が無い呼び出し (コンソール等) は console にまとめる", () => {
    const r = makeFeatureResolver("anthropic", {}, names);
    expect(r(null)).toBe("anthropic:console");
    expect(r(undefined)).toBe("anthropic:console");
  });
});
