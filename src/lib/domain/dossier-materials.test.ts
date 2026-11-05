import { describe, expect, it, vi } from "vitest";

// shapeDossierMaterials は純粋だが、モジュールが DB / R2 のクライアントを読み込むので差し替える
vi.mock("@/lib/db", () => ({ withSession: vi.fn() }));
vi.mock("@/lib/r2", () => ({ getR2PublicUrl: (k: string) => `https://r2/${k}` }));

import { shapeDossierMaterials, type DossierForMaterials } from "./dossier-materials";

type Candidate = DossierForMaterials["placeCandidates"][number];

const candidate = (over: Partial<Candidate>): Candidate => ({
  name: "",
  placeId: null,
  latitude: null,
  longitude: null,
  address: null,
  googleMapsUrl: null,
  note: "",
  certainty: "confirmed",
  certaintyNote: "",
  place: null,
  ...over,
});

const dossier = (placeCandidates: Candidate[]): DossierForMaterials =>
  ({
    id: "d1",
    title: "おでかけ",
    classification: "internal",
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    itemCount: 0,
    items: [],
    placeCandidates,
  }) as unknown as DossierForMaterials;

const place = (name: string, classification = "internal") => ({
  classification,
  latitude: 35.6,
  longitude: 139.7,
  address: "東京都",
  googleMapsUrl: "https://maps.example/p",
  entity: { canonicalName: name },
});

describe("shapeDossierMaterials: 場所候補の確度 (#333)", () => {
  it("聖地に登録済みの候補の確度・理由を placeCertainties に載せる。同じ聖地は並びの先頭", () => {
    const m = shapeDossierMaterials(
      dossier([
        candidate({ placeId: "p1", place: place("神社"), certainty: "likely", certaintyNote: "おみくじだけ" }),
        candidate({ placeId: "p2", place: place("かき氷屋") }),
        candidate({ placeId: "p1", place: place("神社"), certainty: "confirmed" }),
        candidate({ name: "未登録", latitude: 1, longitude: 2, certainty: "likely", certaintyNote: "載らない" }),
      ]),
    );
    expect(m.placeCertainties).toEqual({
      p1: { certainty: "likely", certaintyNote: "おみくじだけ" },
      p2: { certainty: "confirmed", certaintyNote: "" },
    });
    expect(m.linkedPlaceIds).toEqual(["p1", "p2"]);
  });

  it("座標を持たない候補は聖地の座標・住所を使い、候補に値があればそちらを優先する", () => {
    const m = shapeDossierMaterials(
      dossier([
        candidate({ placeId: "p1", place: place("神社") }),
        candidate({ placeId: "p2", place: place("かき氷屋"), latitude: 1, longitude: 2, address: "手入力" }),
      ]),
    );
    expect(m.places[0]).toMatchObject({ lat: 35.6, lng: 139.7, address: "東京都", googleMapsUrl: "https://maps.example/p" });
    expect(m.places[1]).toMatchObject({ lat: 1, lng: 2, address: "手入力" });
  });

  it("見えない (RLS で place が null) 聖地の確度は載せない", () => {
    const m = shapeDossierMaterials(dossier([candidate({ placeId: "secret", place: null, certainty: "likely" })]));
    expect(m.placeCertainties).toEqual({});
  });
});

describe("shapeDossierMaterials: 外部リンク・外部画像", () => {
  const withItems = (items: unknown[]) => ({ ...dossier([]), items }) as unknown as DossierForMaterials;
  const link = (externalUrl: string, caption = "") => ({ kind: "external_link", externalUrl, caption });
  const image = (externalImageKey: string, caption = "") => ({ kind: "external_image", externalImageKey, caption });

  it("TikTok 以外のリンクを links に並べる。X はレポにも残す", () => {
    const m = shapeDossierMaterials(
      withItems([
        link("https://x.com/a/status/1"),
        link("https://www.amazon.co.jp/dp/1\nhttps://shop.example/2", "販売ページ"),
        link("https://www.tiktok.com/@a/video/3"),
        link("メモだけ"),
      ])
    );
    expect(m.links).toEqual([
      { url: "https://x.com/a/status/1", caption: "" },
      { url: "https://www.amazon.co.jp/dp/1", caption: "販売ページ" },
      { url: "https://shop.example/2", caption: "販売ページ" },
    ]);
    expect(m.reports).toEqual(["https://x.com/a/status/1"]);
    expect(m.tiktoks).toEqual(["https://www.tiktok.com/@a/video/3"]);
  });

  it("firstImage はキャプションを問わず先頭、dossierThumb はキャプション「サムネ」だけ", () => {
    const m = shapeDossierMaterials(withItems([image("a.webp"), image("b.webp", "サムネ")]));
    expect(m.firstImage).toBe("https://r2/a.webp");
    expect(m.dossierThumb).toBe("https://r2/b.webp");
  });
});
