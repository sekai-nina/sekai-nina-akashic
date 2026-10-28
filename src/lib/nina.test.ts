import { describe, expect, it } from "vitest";
import { NINA_ENTITY_ID, isNinaAppearance, ninaAppearanceOf } from "./nina";

describe("ninaAppearanceOf", () => {
  it("坂井新奈が紐づいていれば出ている", () => {
    expect(ninaAppearanceOf({ ninaAbsent: false, entities: [{ entityId: "x" }, { entityId: NINA_ENTITY_ID }] })).toBe("appears");
  });
  it("紐づいていても ninaAbsent が立っていれば出ていない (本人の投稿で写っていない画像)", () => {
    expect(ninaAppearanceOf({ ninaAbsent: true, entities: [{ entityId: NINA_ENTITY_ID }] })).toBe("absent");
  });
  it("ninaAbsent だけなら出ていない", () => {
    expect(ninaAppearanceOf({ ninaAbsent: true, entities: [{ entityId: "x" }] })).toBe("absent");
  });
  it("どちらも無ければ未確認", () => {
    expect(ninaAppearanceOf({ ninaAbsent: false, entities: [] })).toBe("unchecked");
  });
});

describe("isNinaAppearance", () => {
  it("3 状態だけを通す", () => {
    expect(["appears", "absent", "unchecked"].every(isNinaAppearance)).toBe(true);
    expect(isNinaAppearance("present")).toBe(false);
    expect(isNinaAppearance(undefined)).toBe(false);
  });
});
