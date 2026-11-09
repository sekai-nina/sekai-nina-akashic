import { describe, expect, it } from "vitest";
import { providedRoleLabel, roleLabelUpdate } from "./role-label";

describe("roleLabelUpdate", () => {
  it("値が無ければ roleLabel に触らない (既存の author を消さない)", () => {
    expect(roleLabelUpdate(undefined)).toEqual({});
    expect(roleLabelUpdate(null)).toEqual({});
    expect(roleLabelUpdate("")).toEqual({});
    expect(roleLabelUpdate("  ")).toEqual({});
  });

  it("中身のある値を渡したときだけ書き換える", () => {
    expect(roleLabelUpdate("出演")).toEqual({ roleLabel: "出演" });
    expect(roleLabelUpdate(" author ")).toEqual({ roleLabel: "author" });
  });
});

describe("providedRoleLabel", () => {
  it("空は undefined", () => {
    expect(providedRoleLabel("")).toBeUndefined();
    expect(providedRoleLabel(null)).toBeUndefined();
    expect(providedRoleLabel("subject")).toBe("subject");
  });
});
