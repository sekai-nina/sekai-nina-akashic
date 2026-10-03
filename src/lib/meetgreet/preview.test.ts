import { describe, expect, it } from "vitest";
import { parseAssetRefs, previewSourceLabel } from "./preview";

describe("previewSourceLabel", () => {
  it("トークの末尾の投稿日時を落とす", () => {
    expect(previewSourceLabel("坂井新奈トーク 2026.4.22 16:37")).toBe("坂井新奈トーク");
  });
  it("ブログのタイトルはそのまま", () => {
    expect(previewSourceLabel("坂井新奈ブログ「夜ってすてき」")).toBe("坂井新奈ブログ「夜ってすてき」");
  });
  it("日付だけのタイトルは空にしない", () => {
    expect(previewSourceLabel("2026.4.22")).toBe("2026.4.22");
  });
});

describe("parseAssetRefs", () => {
  it("URL と ID が混ざっていても ID の並びにする", () => {
    expect(
      parseAssetRefs("https://akashic.sekai-nina.com/assets/cmo0wlfdm01jsmojc51bzm99t\ncmq23ojct02lyi9048xv61tjq")
    ).toEqual(["cmo0wlfdm01jsmojc51bzm99t", "cmq23ojct02lyi9048xv61tjq"]);
  });
  it("空行と重複を落とす", () => {
    expect(parseAssetRefs("\n a1 \n\na1, a2")).toEqual(["a1", "a2"]);
  });
});
