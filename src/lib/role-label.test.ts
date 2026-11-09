import { describe, expect, it } from "vitest";
import { groupRoleLabelUpdates, providedRoleLabel, roleLabelUpdate } from "./role-label";

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
    expect(providedRoleLabel(undefined)).toBeUndefined();
    expect(providedRoleLabel("  ")).toBeUndefined();
    expect(providedRoleLabel(" subject ")).toBe("subject");
  });
});

describe("groupRoleLabelUpdates", () => {
  it("既存で値のあるものだけを値ごとにまとめる。値の無い既存 (MCP の update_asset) と新規は含めない", () => {
    const existing = new Set(["nina", "kawata", "tag"]);
    const got = groupRoleLabelUpdates(
      [
        { entityId: "nina" }, // 既存・値なし → 触らない (author を残す)
        { entityId: "kawata", roleLabel: "出演" },
        { entityId: "tag", roleLabel: "出演" },
        { entityId: "new", roleLabel: "出演" }, // 新規は createMany 側
        { entityId: "nina", roleLabel: "" },
      ],
      existing
    );
    expect([...got.entries()]).toEqual([["出演", ["kawata", "tag"]]]);
  });
});
