import { describe, expect, it } from "vitest";

import { ArticleSourceStatus, ClearanceLevel } from "@prisma/client";

import type { ArticleSourceRow } from "./frontmatter";
import { demotableSources, reconcileSources, type ExistingSourceRow } from "./reconcile";

const row = (over: Partial<ArticleSourceRow>): ArticleSourceRow => ({
  assetId: null,
  status: ArticleSourceStatus.applied,
  classification: ClearanceLevel.public,
  sourceNo: null,
  label: "",
  url: null,
  date: null,
  originalRef: null,
  sortOrder: 0,
  ...over,
});

let seq = 0;
const prev = (over: Partial<ExistingSourceRow>): ExistingSourceRow => ({
  id: `prev${++seq}`,
  assetId: null,
  sourceNo: null,
  status: ArticleSourceStatus.applied,
  originalRef: null,
  excerpt: "",
  excerptType: null,
  excerptStart: null,
  excerptEnd: null,
  note: "",
  ...over,
});

const EXCERPT = { excerpt: "抜粋", excerptType: "body" as const, excerptStart: 10, excerptEnd: 20, note: "メモ" };

describe("reconcileSources — 抜粋の引き継ぎ", () => {
  it("assetId + sourceNo が一致した行に抜粋を写す", () => {
    const { rows } = reconcileSources(
      [prev({ assetId: "a1", sourceNo: 2, ...EXCERPT })],
      [row({ assetId: "a1", sourceNo: 1 }), row({ assetId: "a1", sourceNo: 2 })],
    );
    expect(rows[0]).not.toHaveProperty("excerpt");
    expect(rows[1]).toMatchObject({ assetId: "a1", sourceNo: 2, ...EXCERPT });
  });

  it("frontmatter 由来の列 (label / url / status) は今回の値のまま", () => {
    const { rows } = reconcileSources(
      [prev({ assetId: "a1", sourceNo: 1, ...EXCERPT })],
      [row({ assetId: "a1", sourceNo: 1, label: "新ラベル", url: "https://x" })],
    );
    expect(rows[0]).toMatchObject({ label: "新ラベル", url: "https://x", excerpt: "抜粋" });
  });

  it("抜粋の無い既存行に対応しても行は入力のまま (キーを増やさない)", () => {
    const wanted = [row({ assetId: "a1", sourceNo: 1 })];
    const { rows } = reconcileSources([prev({ assetId: "a1", sourceNo: 1 })], wanted);
    expect(rows).toEqual(wanted);
  });

  it("sourceNo が違えば写さない (人手で振り直された可能性)", () => {
    const { rows } = reconcileSources(
      [prev({ assetId: "a1", sourceNo: 1, ...EXCERPT })],
      [row({ assetId: "a1", sourceNo: 3 })],
    );
    expect(rows[0]).not.toHaveProperty("excerpt");
  });

  it("sourceNo の無い行は、そのアセットが双方 1 行だけのときに写す", () => {
    const { rows } = reconcileSources(
      [prev({ assetId: "a1", sourceNo: null, ...EXCERPT })],
      [row({ assetId: "a1", sourceNo: null, url: "https://x" })],
    );
    expect(rows[0]).toMatchObject(EXCERPT);
  });

  it("sourceNo の無い行で今回側に同じアセットが複数あれば写さない (取り違え防止)", () => {
    const { rows } = reconcileSources(
      [prev({ assetId: "a1", sourceNo: null, ...EXCERPT })],
      [row({ assetId: "a1", sourceNo: null }), row({ assetId: "a1", sourceNo: null })],
    );
    expect(rows[0]).not.toHaveProperty("excerpt");
    expect(rows[1]).not.toHaveProperty("excerpt");
  });

  it("sourceNo の無い行で既存側に同じアセットが複数あれば写さない (抜粋の有無に依らず)", () => {
    const { rows } = reconcileSources(
      [prev({ assetId: "a1", sourceNo: null, ...EXCERPT }), prev({ assetId: "a1", sourceNo: null })],
      [row({ assetId: "a1", sourceNo: null })],
    );
    expect(rows[0]).not.toHaveProperty("excerpt");
  });

  it("1 つの既存行を 2 行に写さない", () => {
    const { rows } = reconcileSources(
      [prev({ assetId: "a1", sourceNo: 1, ...EXCERPT })],
      [row({ assetId: "a1", sourceNo: 1 }), row({ assetId: "a1", sourceNo: 1 })],
    );
    expect(rows[0]).toHaveProperty("excerpt", "抜粋");
    expect(rows[1]).not.toHaveProperty("excerpt");
  });

  it("assetId の無い行 (unresolved) は対象外", () => {
    const { rows } = reconcileSources(
      [prev({ assetId: null, sourceNo: 1, ...EXCERPT })],
      [row({ assetId: null, sourceNo: 1, originalRef: "gone" })],
    );
    expect(rows[0]).not.toHaveProperty("excerpt");
  });
});

describe("reconcileSources — unmatched", () => {
  it("対応した既存行は unmatched に出ない", () => {
    const matched = prev({ assetId: "a1", sourceNo: 1 });
    const gone = prev({ assetId: "a2", sourceNo: 2 });
    const { unmatched } = reconcileSources([matched, gone], [row({ assetId: "a1", sourceNo: 1 })]);
    expect(unmatched).toEqual([gone]);
  });

  it("既存行が空なら unmatched も空", () => {
    expect(reconcileSources([], [row({ assetId: "a1", sourceNo: 1 })]).unmatched).toEqual([]);
  });
});

describe("demotableSources", () => {
  it("akashic で apply した行 (applied / originalRef null / asset あり) だけを返す", () => {
    const akashic = prev({ assetId: "a1", sourceNo: 3, status: ArticleSourceStatus.applied, originalRef: null });
    const fromFile = prev({ assetId: "a2", sourceNo: 1, status: ArticleSourceStatus.applied, originalRef: "a2" });
    const unresolved = prev({ assetId: null, sourceNo: 2, status: ArticleSourceStatus.unresolved, originalRef: "x" });
    expect(demotableSources([akashic, fromFile, unresolved])).toEqual([akashic]);
  });

  it("asset が消えた行 (assetId null) は戻さない", () => {
    expect(demotableSources([prev({ assetId: null, sourceNo: 3, originalRef: null })])).toEqual([]);
  });
});
