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

const place = (name: string, classification = "internal") => ({ classification, entity: { canonicalName: name } });

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

  it("見えない (RLS で place が null) 聖地の確度は載せない", () => {
    const m = shapeDossierMaterials(dossier([candidate({ placeId: "secret", place: null, certainty: "likely" })]));
    expect(m.placeCertainties).toEqual({});
  });
});
