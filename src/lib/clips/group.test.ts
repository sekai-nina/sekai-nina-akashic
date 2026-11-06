import { describe, expect, it } from "vitest";
import { groupClipRows } from "./group";

const row = (id: string, clipGroupId: string | null, sortOrder: number, note = "") => ({ id, clipGroupId, sortOrder, note });

describe("groupClipRows", () => {
  it("グループの無い行はそれぞれ 1 件のクリップになる", () => {
    expect(groupClipRows([row("a", null, 1), row("b", null, 2)]).map((g) => g.members.map((m) => m.id))).toEqual([["a"], ["b"]]);
  });

  it("同じグループの行を sortOrder 順に束ね、一覧の順は最初に出た位置に置く", () => {
    const groups = groupClipRows([row("c", "g", 3), row("x", null, 9), row("a", "g", 1)]);
    expect(groups.map((g) => g.members.map((m) => m.id))).toEqual([["a", "c"], ["x"]]);
  });

  it("代表はメモのある行を優先する (先頭の行が消えてもメモを編集できる)", () => {
    expect(groupClipRows([row("a", "g", 1), row("b", "g", 2, "メモ")])[0].head.id).toBe("b");
    expect(groupClipRows([row("a", "g", 1), row("b", "g", 2)])[0].head.id).toBe("a");
  });
});
