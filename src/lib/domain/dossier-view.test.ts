import { describe, expect, it } from "vitest";
import { deriveAssetPlaceSuggestions, dossierItemBody, isTalkAsset, toDossierRows } from "./dossier-view";

const place = (id: string) => ({ id, latitude: 35.6, longitude: 139.7, address: "東京都", googleMapsUrl: null });
const item = (id: string, ...links: [string, string][]) => ({
  asset: {
    id,
    title: `アセット${id}`,
    entities: links.map(([placeId, name]) => ({ entity: { canonicalName: name, place: place(placeId) } })),
  },
});

describe("deriveAssetPlaceSuggestions", () => {
  it("アセットの聖地を出し、同じ聖地のアセットはまとめる", () => {
    const got = deriveAssetPlaceSuggestions([item("a", ["p1", "神社"]), item("b", ["p1", "神社"], ["p2", "かき氷屋"])], []);
    expect(got.map((s) => [s.id, s.name, s.assets.map((a) => a.id)])).toEqual([
      ["p1", "神社", ["a", "b"]],
      ["p2", "かき氷屋", ["b"]],
    ]);
  });

  it("抜粋ごとに同じアセットが複数入っていても 1 つに数える", () => {
    const got = deriveAssetPlaceSuggestions([item("a", ["p1", "神社"]), item("a", ["p1", "神社"])], []);
    expect(got[0].assets).toHaveLength(1);
  });

  it("もう候補にある聖地は出さない (機密で place が見えない候補も placeId で分かる)", () => {
    const got = deriveAssetPlaceSuggestions([item("a", ["p1", "神社"])], [{ placeId: "p1", name: "" }]);
    expect(got).toEqual([]);
  });

  it("同じ名前の手入力の候補があれば出さない", () => {
    const got = deriveAssetPlaceSuggestions([item("a", ["p1", "神社"])], [{ placeId: null, name: " 神社 " }]);
    expect(got).toEqual([]);
  });

  it("見えないアセットと、聖地が見えないエンティティは飛ばす", () => {
    const hidden = { asset: { id: "h", title: "", entities: [{ entity: { canonicalName: "秘密", place: null } }] } };
    expect(deriveAssetPlaceSuggestions([{ asset: null }, hidden], [])).toEqual([]);
  });
});

describe("toDossierRows", () => {
  const asset = {
    id: "a",
    kind: "text",
    title: "題",
    thumbnailUrl: null,
    texts: [{ textType: "body", content: "本文" }],
    sourceRecords: [{ sourceKind: "url", title: "題", url: "https://example.com/1" }],
    entities: [],
  };

  it("本文は同じアセットの先頭の行だけに出し、asset から本文と聖地を外す", () => {
    const rows = toDossierRows([
      { id: "1", asset },
      { id: "2", asset },
      { id: "3", asset: null },
    ]);
    expect(rows.map((r) => r.body?.text ?? null)).toEqual(["本文", null, null]);
    expect(rows[0].item).toEqual({
      id: "1",
      asset: { id: "a", kind: "text", title: "題", thumbnailUrl: null },
    });
  });
});

describe("dossierItemBody", () => {
  const talkSource: { sourceKind: string; title: string; url: string | null } = { sourceKind: "other", title: "Talk メッセージ #1", url: null };
  const blogSource = { sourceKind: "url", title: "坂井新奈ブログ「題」", url: "https://example.com/blog/1" };
  const asset = (texts: { textType: string; content: string }[], source: typeof talkSource = blogSource, kind = "text") => ({
    id: "a",
    kind,
    title: "題",
    texts,
    sourceRecords: [source],
  });

  it("トークは kind によらず全文、ブログは窓", () => {
    const talk = asset([{ textType: "message_body", content: "おはよう" }], talkSource, "image");
    expect(dossierItemBody(talk)).toEqual({ text: "おはよう", full: true });
    expect(dossierItemBody(asset([{ textType: "body", content: "本文" }]))?.full).toBe(false);
  });

  it("本文の無い画像だけのトークもトークと分かる", () => {
    expect(isTalkAsset(asset([], talkSource, "image"))).toBe(true);
    expect(isTalkAsset(asset([], blogSource, "image"))).toBe(false);
  });

  it("メッセージと文字起こしの両方を出し、同じ内容は 1 回にする", () => {
    const got = dossierItemBody(
      asset(
        [
          { textType: "transcript", content: "こんにちは" },
          { textType: "message_body", content: "動画です" },
          { textType: "body", content: "動画です" },
        ],
        talkSource,
        "video"
      )
    );
    expect(got?.text).toBe("動画です\n\nこんにちは");
  });

  it("本文の無いアセットは null。画像の差し込みだけの本文も無いのと同じ", () => {
    expect(dossierItemBody(asset([]))).toBeNull();
    expect(dossierItemBody(asset([{ textType: "note", content: "メモ" }]))).toBeNull();
    expect(dossierItemBody(asset([{ textType: "body", content: " {{IMG:abc}} " }]))).toBeNull();
  });
});
