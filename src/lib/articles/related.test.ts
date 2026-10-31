import { describe, expect, it } from "vitest";
import { bodyLinksTo, normalizeRelated, readRelated, sameRelated, withRelated } from "./related";

describe("readRelated", () => {
  it("文字列だけを順に取り出す", () => {
    expect(readRelated({ related: ["B", "A"] })).toEqual(["B", "A"]);
  });
  it("空要素 (related:\\n  -) や null を落とす", () => {
    expect(readRelated({ related: [null] })).toEqual([]);
    expect(readRelated({ related: ["A", null, ""] })).toEqual(["A"]);
  });
  it("保存時と同じく trim・重複を落とす", () => {
    expect(readRelated({ related: [" A", "A", "B "] })).toEqual(["A", "B"]);
  });
  it("related が無い・配列でない・extra が壊れているときは空", () => {
    expect(readRelated({})).toEqual([]);
    expect(readRelated({ related: "A" })).toEqual([]);
    expect(readRelated(null)).toEqual([]);
    expect(readRelated([])).toEqual([]);
  });
});

describe("normalizeRelated", () => {
  it("trim して空と重複を落とし、順序は保つ", () => {
    expect(normalizeRelated([" B ", "A", "", "B"])).toEqual(["B", "A"]);
  });
});

describe("withRelated", () => {
  it("related だけ差し替えて他のキーは残す", () => {
    expect(withRelated({ author: "a", related: ["x"] }, ["y", "z"])).toEqual({ author: "a", related: ["y", "z"] });
  });
  it("空ならキーごと消す", () => {
    expect(withRelated({ author: "a", related: ["x"] }, [])).toEqual({ author: "a" });
  });
  it("元のオブジェクトを書き換えない", () => {
    const extra = { related: ["x"] };
    withRelated(extra, []);
    expect(extra).toEqual({ related: ["x"] });
  });
});

describe("sameRelated", () => {
  it("並び順も比べる", () => {
    expect(sameRelated(["A", "B"], ["A", "B"])).toBe(true);
    expect(sameRelated(["A", "B"], ["B", "A"])).toBe(false);
  });
});

describe("bodyLinksTo", () => {
  it("[[題]] / [[題|表示]] / テーブル内の [[題\\|表示]] を拾う", () => {
    expect(bodyLinksTo("初出は[[題]]", "題")).toBe(true);
    expect(bodyLinksTo("[[題|あの日]]", "題")).toBe(true);
    expect(bodyLinksTo("| [[題\\|あの日]] |", "題")).toBe(true);
  });
  it("前方一致の別タイトルは拾わない", () => {
    expect(bodyLinksTo("[[題名]]", "題")).toBe(false);
  });
  it("空タイトルは拾わない", () => {
    expect(bodyLinksTo("[[]]", "")).toBe(false);
  });
});
