import { describe, expect, it } from "vitest";
import { uploadClassification } from "./classification";

describe("uploadClassification", () => {
  it("指定が無ければ、送り主が restricted でも internal", () => {
    expect(uploadClassification(undefined, "restricted")).toBe("internal");
    expect(uploadClassification("", "confidential")).toBe("internal");
    expect(uploadClassification(null, "internal")).toBe("internal");
  });

  it("送り主が internal より低ければ送り主に合わせる", () => {
    expect(uploadClassification(undefined, "public")).toBe("public");
  });

  it("指定があればそれを使う (上げすぎは createAsset の assertClearance が止める)", () => {
    expect(uploadClassification("restricted", "restricted")).toBe("restricted");
    expect(uploadClassification("public", "internal")).toBe("public");
  });

  it("知らない値は null", () => {
    expect(uploadClassification("secret", "restricted")).toBeNull();
    expect(uploadClassification("toString", "restricted")).toBeNull();
  });
});
