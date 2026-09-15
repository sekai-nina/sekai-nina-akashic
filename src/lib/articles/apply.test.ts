import { describe, expect, it } from "vitest";

import { ClearanceLevel } from "@prisma/client";

import { isAboveClearance } from "@/lib/classification";

import { API_APPLY_MAX_CLASSIFICATION, nextSortOrder, nextSourceNo } from "./apply";

describe("nextSourceNo", () => {
  it("既存の最大 + 1", () => {
    expect(nextSourceNo([1, 2, 3], "本文")).toBe(4);
  });

  it("番号が無ければ 1", () => {
    expect(nextSourceNo([], "")).toBe(1);
    expect(nextSourceNo([null, null], "")).toBe(1);
  });

  it("null (番号なしの行) は無視する", () => {
    expect(nextSourceNo([null, 2, null], "")).toBe(3);
  });

  it("本文の ^[n] が既存より大きければそれを超える (宛先の無い脚注に結びつけない)", () => {
    expect(nextSourceNo([1, 2], "根拠^[2]と^[7]")).toBe(8);
  });

  it("本文の ^[n] が既存以下なら影響しない", () => {
    expect(nextSourceNo([1, 2, 3], "根拠^[1]")).toBe(4);
  });

  it("[[3]] (数字だけの wikilink) は脚注として数えない", () => {
    expect(nextSourceNo([1], "[[9]]")).toBe(2);
  });
});

describe("nextSortOrder", () => {
  it("非 pending 行の末尾", () => {
    expect(nextSortOrder([0, 1, 2])).toBe(3);
  });

  it("行が無ければ 0 (取り込みの採番と同じ起点)", () => {
    expect(nextSortOrder([])).toBe(0);
  });

  it("歯抜けでも最大 + 1", () => {
    expect(nextSortOrder([0, 5])).toBe(6);
  });
});

describe("API_APPLY_MAX_CLASSIFICATION", () => {
  it("internal 以下は API から apply できる", () => {
    expect(isAboveClearance(ClearanceLevel.public, API_APPLY_MAX_CLASSIFICATION)).toBe(false);
    expect(isAboveClearance(ClearanceLevel.internal, API_APPLY_MAX_CLASSIFICATION)).toBe(false);
  });

  it("confidential / restricted は API から apply できない", () => {
    expect(isAboveClearance(ClearanceLevel.confidential, API_APPLY_MAX_CLASSIFICATION)).toBe(true);
    expect(isAboveClearance(ClearanceLevel.restricted, API_APPLY_MAX_CLASSIFICATION)).toBe(true);
  });

  it("未知の値は fail-closed で上扱い", () => {
    expect(isAboveClearance("secret", API_APPLY_MAX_CLASSIFICATION)).toBe(true);
  });
});
