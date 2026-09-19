import { describe, expect, it } from "vitest";

import { cropsFromJson, isValidCrop, toPixelRect, withCrops, MIN_CROP_PIXELS } from "./crop";

const FULL = { x: 0, y: 0, w: 1, h: 1 };
const RIGHT_HALF = { x: 0.5, y: 0, w: 0.5, h: 1 };

describe("isValidCrop", () => {
  it("割合として妥当な枠を通す", () => {
    expect(isValidCrop(FULL)).toBe(true);
    expect(isValidCrop(RIGHT_HALF)).toBe(true);
  });

  it("画像の外にはみ出す枠は弾く", () => {
    expect(isValidCrop({ x: 0.6, y: 0, w: 0.5, h: 1 })).toBe(false);
    expect(isValidCrop({ x: 0, y: 0.9, w: 1, h: 0.2 })).toBe(false);
  });

  it("潰れた枠・数でないものは弾く", () => {
    expect(isValidCrop({ x: 0, y: 0, w: 0.001, h: 1 })).toBe(false);
    expect(isValidCrop({ x: 0, y: 0, w: 1 })).toBe(false);
    expect(isValidCrop({ x: -0.1, y: 0, w: 1, h: 1 })).toBe(false);
    expect(isValidCrop({ x: 0, y: 0, w: Number.NaN, h: 1 })).toBe(false);
    expect(isValidCrop(null)).toBe(false);
    expect(isValidCrop([0, 0, 1, 1])).toBe(false);
  });

  it("丸めで 1 をわずかに超えるのは許す", () => {
    expect(isValidCrop({ x: 0.30005, y: 0, w: 0.7, h: 1 })).toBe(true);
  });
});

describe("cropsFromJson", () => {
  it("壊れているものは落として、生成を止めない", () => {
    const crops = cropsFromJson({
      good: RIGHT_HALF,
      broken: { x: "0", y: 0, w: 1, h: 1 },
      outside: { x: 0.9, y: 0, w: 0.5, h: 1 },
    });
    expect(Object.keys(crops)).toEqual(["good"]);
  });

  it("Json 列が配列・null でも落ちない", () => {
    expect(cropsFromJson(null)).toEqual({});
    expect(cropsFromJson([1, 2])).toEqual({});
    expect(cropsFromJson("{}")).toEqual({});
  });
});

describe("withCrops", () => {
  it("null を渡すと枠を外す (画像全体を使う)", () => {
    const next = withCrops({ a: RIGHT_HALF, b: FULL }, { a: null });
    expect(next).toEqual({ b: FULL });
  });

  it("元の Map は変えない", () => {
    const current = { a: RIGHT_HALF };
    withCrops(current, { a: null, b: FULL });
    expect(current).toEqual({ a: RIGHT_HALF });
  });

  it("妥当でない枠は無視する (消しもしない)", () => {
    const next = withCrops({ a: RIGHT_HALF }, { a: { x: 2, y: 0, w: 1, h: 1 } });
    expect(next).toEqual({ a: RIGHT_HALF });
  });
});

describe("toPixelRect", () => {
  it("割合を画素に直す", () => {
    expect(toPixelRect(RIGHT_HALF, 1280, 960)).toEqual({
      left: 640,
      top: 0,
      width: 640,
      height: 960,
    });
  });

  it("端数で画像の外に出ないように収める", () => {
    const r = toPixelRect({ x: 0.999, y: 0, w: 0.5, h: 1 }, 100, 100);
    expect(r).toBeNull(); // 残り 1px では参照にならない
    const r2 = toPixelRect({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 101, 101)!;
    expect(r2.left + r2.width).toBeLessThanOrEqual(101);
    expect(r2.top + r2.height).toBeLessThanOrEqual(101);
  });

  it("小さすぎる枠は null (切らずに送る)", () => {
    const tiny = MIN_CROP_PIXELS / 2 / 100;
    expect(toPixelRect({ x: 0, y: 0, w: tiny, h: 1 }, 100, 100)).toBeNull();
  });

  it("寸法が読めないときは null", () => {
    expect(toPixelRect(FULL, 0, 100)).toBeNull();
    expect(toPixelRect(FULL, Number.NaN, 100)).toBeNull();
  });
});
