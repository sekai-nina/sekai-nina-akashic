import { describe, expect, it } from "vitest";

import { describeRate, formatMoney, isCurrency, toUsd } from "./currency";

describe("toUsd", () => {
  it("レートで割って 2 桁に丸める", () => {
    expect(toUsd(3000, 155)).toBe(19.35);
    expect(toUsd(30, 1)).toBe(30);
  });

  it("0 は 0 のまま通す (残高を使い切った状態)", () => {
    expect(toUsd(0, 155)).toBe(0);
  });

  it("不正なレート・金額は null", () => {
    // 0 除算で Infinity を残高に入れない
    expect(toUsd(3000, 0)).toBeNull();
    expect(toUsd(3000, -155)).toBeNull();
    // 桁を間違えた入力
    expect(toUsd(3000, 1_000_000)).toBeNull();
    expect(toUsd(-1, 155)).toBeNull();
    expect(toUsd(Number.NaN, 155)).toBeNull();
  });
});

describe("formatMoney", () => {
  it("円は小数を出さない", () => {
    expect(formatMoney(3000, "JPY")).toContain("3,000");
    expect(formatMoney(3000, "JPY")).not.toContain(".");
  });

  it("USD は 2 桁", () => {
    expect(formatMoney(19.35, "USD")).toContain("19.35");
  });
});

describe("isCurrency / describeRate", () => {
  it("知らない通貨は弾く", () => {
    expect(isCurrency("JPY")).toBe(true);
    expect(isCurrency("EUR")).toBe(false);
  });

  it("USD のときはレートを説明しない", () => {
    expect(describeRate("USD", 1)).toBe("");
    expect(describeRate("JPY", 155)).toBe("1 USD = 155 JPY");
  });
});
