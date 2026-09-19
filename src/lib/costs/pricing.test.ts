import { describe, expect, it } from "vitest";

import { computeCostUsd, findPricing } from "./pricing";
describe("findPricing", () => {
  it("完全一致で引ける", () => {
    expect(findPricing("openai", "gpt-4o-mini")).toEqual({ input: 0.15, output: 0.6 });
  });

  it("日付サフィックス付き・models/ 接頭辞付きでも引ける", () => {
    expect(findPricing("anthropic", "claude-sonnet-4-6-20260514")?.input).toBe(3);
    expect(findPricing("google", "models/gemini-3.1-flash-lite")?.input).toBe(0.25);
  });

  it("前方一致は長いキーを優先する (gpt-5.4-mini が gpt-5.4 に落ちない)", () => {
    expect(findPricing("openai", "gpt-5.4-mini-2026-09-01")).toEqual({ input: 0.75, output: 4.5 });
  });

  it("知らないモデルは null", () => {
    expect(findPricing("openai", "gpt-9-imaginary")).toBeNull();
    expect(findPricing("anthropic", "")).toBeNull();
  });
});

describe("computeCostUsd", () => {
  it("入力・出力を 100 万トークン単価で計算する", () => {
    // gpt-4o: $2.50 / $10.00
    expect(computeCostUsd("openai", "gpt-4o", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(2.5);
    expect(computeCostUsd("openai", "gpt-4o", { inputTokens: 0, outputTokens: 500_000 })).toBe(5);
  });

  it("Anthropic のキャッシュ読み出しは入力の 1/10", () => {
    // claude-sonnet-4-6: input $3 → cached $0.30
    expect(
      computeCostUsd("anthropic", "claude-sonnet-4-6", {
        inputTokens: 0,
        cachedInputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBe(0.3);
  });

  it("キャッシュ単価が無いプロバイダは入力と同じ単価で見積もる (高めに出す)", () => {
    expect(computeCostUsd("openai", "gpt-4o", { inputTokens: 0, cachedInputTokens: 1_000_000, outputTokens: 0 })).toBe(2.5);
  });

  it("埋め込みは出力 0 円", () => {
    expect(computeCostUsd("google", "gemini-embedding-2", { inputTokens: 1_000_000, outputTokens: 999 })).toBe(0.2);
  });

  it("単価表に無いモデルは null (勝手に 0 円にしない)", () => {
    expect(computeCostUsd("openai", "gpt-9-imaginary", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeNull();
  });

  it("小数 6 桁に丸める (DB の Decimal(12,6) に合わせる)", () => {
    const v = computeCostUsd("openai", "gpt-4o-mini", { inputTokens: 741, outputTokens: 47 });
    expect(v).toBe(Math.round(v! * 1e6) / 1e6);
  });
});
