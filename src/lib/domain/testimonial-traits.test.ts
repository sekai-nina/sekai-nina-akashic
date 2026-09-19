import { describe, expect, it } from "vitest";
import { canonicalTrait, normalizeTrait, splitTraits } from "./testimonial-traits";

describe("normalizeTrait", () => {
  it("表記ゆれを寄せる", () => {
    expect(canonicalTrait("可愛らしい")).toBe("可愛い");
    expect(canonicalTrait("愛されエピソード")).toBe("愛されている");
    expect(canonicalTrait(" かわいい ")).toBe("可愛い");
  });

  it("表に無い語はそのまま", () => {
    expect(canonicalTrait("方向音痴")).toBe("方向音痴");
    expect(canonicalTrait("しなやかなダンス")).toBe("しなやかなダンス");
  });

  it("複数入りは分けて寄せ、重複を落として ', ' で戻す", () => {
    expect(splitTraits("優しい, 多彩な表現、可愛い")).toEqual(["優しい", "多彩な表現", "可愛い"]);
    expect(normalizeTrait("可愛い, 可愛らしい")).toBe("可愛い");
    expect(normalizeTrait("心優しい、愛されキャラ")).toBe("優しい, 愛されている");
    expect(normalizeTrait("")).toBe("");
  });
});
