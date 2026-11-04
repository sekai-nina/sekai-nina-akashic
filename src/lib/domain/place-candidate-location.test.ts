import { describe, expect, it } from "vitest";
import { resolveCandidateLocation } from "./place-candidate-location";

const place = {
  latitude: 35.6,
  longitude: 139.7,
  address: "東京都",
  googleMapsUrl: "https://maps.example/p",
  entity: { canonicalName: "神社" },
};
const blank = { placeId: null, name: "", latitude: null, longitude: null, address: null, googleMapsUrl: null, place: null };

describe("resolveCandidateLocation", () => {
  it("聖地を指すだけの候補は聖地の値を使う", () => {
    expect(resolveCandidateLocation({ ...blank, placeId: "p", place })).toEqual({
      name: "神社",
      latitude: 35.6,
      longitude: 139.7,
      address: "東京都",
      googleMapsUrl: "https://maps.example/p",
    });
  });

  it("候補に値があればそちらを優先する", () => {
    const got = resolveCandidateLocation({ ...blank, placeId: "p", place, latitude: 1, longitude: 2, address: "手入力" });
    expect(got).toMatchObject({ latitude: 1, longitude: 2, address: "手入力" });
  });

  it("座標は組で補う (片方だけの候補に聖地の値を混ぜない)", () => {
    const got = resolveCandidateLocation({ ...blank, placeId: "p", place, latitude: 1 });
    expect(got).toMatchObject({ latitude: 35.6, longitude: 139.7 });
  });

  it("見えない聖地を指す候補は、行に値が残っていても何も返さない", () => {
    const got = resolveCandidateLocation({ ...blank, placeId: "secret", name: "店", latitude: 1, longitude: 2, address: "住所" });
    expect(got).toEqual({ name: "", latitude: null, longitude: null, address: null, googleMapsUrl: null });
  });

  it("手入力の候補はそのまま", () => {
    const got = resolveCandidateLocation({ ...blank, name: "店", latitude: 1, longitude: 2 });
    expect(got).toMatchObject({ name: "店", latitude: 1, longitude: 2 });
  });
});
