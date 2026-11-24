import { describe, expect, it } from "vitest";
import { parseSceneVideoKind, sceneVideoKindWhere } from "./filters";

describe("動画の場面の種類の絞り込み", () => {
  it("知らない値は絞り込みなしにする", () => {
    expect(parseSceneVideoKind("program")).toBe("program");
    expect(parseSceneVideoKind("x")).toBeNull();
    expect(parseSceneVideoKind(undefined)).toBeNull();
    expect(sceneVideoKindWhere(null)).toEqual({});
  });
  it("番組はトーク・TikTok・ゲームと重ならず、その他は全部の否定になる", () => {
    const program = JSON.stringify(sceneVideoKindWhere("program"));
    expect(program).toContain("Talk (Sony Music)");
    expect(program).toContain('"NOT"');
    const other = sceneVideoKindWhere("other") as { NOT: unknown[] };
    expect(other.NOT).toHaveLength(4);
  });
});
