import { describe, expect, it } from "vitest";
import { planDossierAdditions, planDossierRemovals, type SyncItem, type SyncSource } from "./dossier-sync";

function src(over: Partial<SyncSource> = {}): SyncSource {
  return {
    assetId: "a1",
    url: null,
    refArticleId: null,
    label: "",
    excerpt: "",
    excerptType: null,
    excerptStart: null,
    excerptEnd: null,
    note: "",
    classification: "public",
    asset: { title: "坂井新奈ブログ「題」", classification: "internal" },
    ...over,
  };
}

function item(over: Partial<SyncItem> = {}): SyncItem {
  return { id: "i1", assetId: "a1", externalUrl: null, excerpt: "", note: "", ...over };
}

describe("planDossierAdditions", () => {
  it("企画に無いアセットの出典を足し、題はラベル → アセットの題の順で埋める", () => {
    const plan = planDossierAdditions(
      [src({ assetId: "a1", label: "ラベル" }), src({ assetId: "a2" })],
      [],
      "internal"
    );
    expect(plan.add.map((a) => [a.assetId, a.caption, a.kind])).toEqual([
      ["a1", "ラベル", "asset_ref"],
      ["a2", "坂井新奈ブログ「題」", "asset_ref"],
    ]);
  });

  it("企画に同じアセットがあれば足さない。同じ出典が 2 行あっても 1 件だけ足す", () => {
    const plan = planDossierAdditions(
      [src({ assetId: "a1" }), src({ assetId: "a2" }), src({ assetId: "a2", excerpt: "別の抜粋" })],
      [item({ assetId: "a1" })],
      "internal"
    );
    expect(plan.add.map((a) => a.assetId)).toEqual(["a2"]);
  });

  it("アセットの無い URL の出典は外部リンクとして足し、企画の外部リンクと URL で照合する", () => {
    const plan = planDossierAdditions(
      [src({ assetId: null, asset: null, url: "https://example.com/a" }), src({ assetId: null, asset: null, url: "https://example.com/b " })],
      [item({ assetId: null, externalUrl: "https://example.com/a" })],
      "internal"
    );
    expect(plan.add).toEqual([
      expect.objectContaining({ kind: "external_link", assetId: null, externalUrl: "https://example.com/b" }),
    ]);
  });

  it("記事出典と、アセットも URL も無い行は足さない", () => {
    const plan = planDossierAdditions(
      [src({ assetId: null, asset: null, url: "/articles/abc", refArticleId: "art" }), src({ assetId: null, asset: null })],
      [],
      "internal"
    );
    expect(plan.add).toEqual([]);
  });

  it("行かアセットの機密レベルが企画より上なら足さずに返す", () => {
    const plan = planDossierAdditions(
      [
        src({ assetId: "a1", classification: "confidential" }),
        src({ assetId: "a2", asset: { title: "t", classification: "restricted" } }),
        src({ assetId: "a3" }),
      ],
      [],
      "internal"
    );
    expect(plan.add.map((a) => a.assetId)).toEqual(["a3"]);
    expect(plan.skippedAbove.map((s) => s.assetId)).toEqual(["a1", "a2"]);
  });

  it("記事出典は refArticleId が空でも URL の形で見分けて足さない", () => {
    const plan = planDossierAdditions([src({ assetId: null, asset: null, url: "/articles/AbC1234" })], [], "internal");
    expect(plan.add).toEqual([]);
  });

  it("機密で見送った行があっても、同じアセットの機密の低い行は足す", () => {
    const plan = planDossierAdditions(
      [src({ assetId: "a1", classification: "confidential" }), src({ assetId: "a1", classification: "internal", excerpt: "低い抜粋" })],
      [],
      "internal"
    );
    expect(plan.add.map((a) => a.excerpt)).toEqual(["低い抜粋"]);
    expect(plan.skippedAbove).toHaveLength(1);
  });

  it("上限 (企画と所有者の低い方) が public なら internal の出典は足さない", () => {
    const plan = planDossierAdditions([src({ classification: "internal" })], [], "public");
    expect(plan.add).toEqual([]);
  });

  it("抜粋とメモを引き継ぐ", () => {
    const plan = planDossierAdditions(
      [src({ excerpt: "抜粋", excerptType: "body", excerptStart: 1, excerptEnd: 3, note: "メモ" })],
      [],
      "internal"
    );
    expect(plan.add[0]).toMatchObject({ excerpt: "抜粋", excerptType: "body", excerptStart: 1, excerptEnd: 3, note: "メモ" });
  });
});

describe("planDossierRemovals", () => {
  it("外した出典の写しのアイテム (空、または出典と同じ抜粋・メモ) は消す", () => {
    const plan = planDossierRemovals(
      [src({ assetId: "a1" }), src({ assetId: "a2", excerpt: "抜粋" })],
      [],
      [item({ id: "i1", assetId: "a1" }), item({ id: "i2", assetId: "a2", excerpt: "抜粋" }), item({ id: "i3", assetId: "a3" })]
    );
    expect(plan).toEqual({ deleteItemIds: ["i1", "i2"], exclusionKeys: [] });
  });

  it("人がメモ・抜粋を書いたアイテムは消さずに足さないにする", () => {
    const plan = planDossierRemovals(
      [src({ assetId: "a1" })],
      [],
      [item({ id: "i1", assetId: "a1", note: "人のメモ" }), item({ id: "i2", assetId: "a1", excerpt: "人の抜粋\n2 行目" })]
    );
    expect(plan.deleteItemIds).toEqual([]);
    expect(plan.exclusionKeys).toEqual(["asset:a1", expect.stringMatching(/^quote:/)]);
  });

  it("同じアセットの出典がまだ残っていれば何もしない", () => {
    const plan = planDossierRemovals([src({ assetId: "a1" })], [src({ assetId: "a1" })], [item({ id: "i1", assetId: "a1" })]);
    expect(plan).toEqual({ deleteItemIds: [], exclusionKeys: [] });
  });

  it("URL の出典を外したら同じ URL の外部リンクを消す。メモ付きの外部リンクは印を付けずに残す", () => {
    const plan = planDossierRemovals(
      [src({ assetId: null, asset: null, url: "https://example.com/a" })],
      [],
      [
        item({ id: "i1", assetId: null, externalUrl: "https://example.com/a" }),
        item({ id: "i2", assetId: null, externalUrl: "https://example.com/a", note: "メモ" }),
      ]
    );
    expect(plan).toEqual({ deleteItemIds: ["i1"], exclusionKeys: [] });
  });
});
