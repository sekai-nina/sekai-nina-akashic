import { describe, expect, it } from "vitest";
import { buildPlaceMapData, type PlaceRow } from "./map";

const row = (id: string, o: Partial<PlaceRow> = {}): PlaceRow => ({
  id,
  latitude: 35.6,
  longitude: 139.7,
  googleMapsUrl: null,
  address: null,
  kind: null,
  area: null,
  classification: "internal",
  createdAt: "2026-10-01T00:00:00.000Z",
  entity: { canonicalName: id, description: "", _count: { assets: 0 } },
  articles: [],
  ...o,
});
const art = (shortId: string, sortOrder: number, date: string | null = null) => ({
  sortOrder,
  article: { shortId, title: `記事${shortId}`, date, dateDisplay: null },
});

describe("buildPlaceMapData", () => {
  const now = new Date("2026-10-29T00:00:00.000Z");

  it("登録から 14 日以内だけ NEW にする (unstable_cache 経由の文字列の日付も読む)", () => {
    const d = buildPlaceMapData(
      [row("a", { createdAt: "2026-10-20T00:00:00.000Z" }), row("b", { createdAt: new Date("2026-10-10T00:00:00.000Z") })],
      now,
    );
    expect(d.places.map((p) => [p.id, p.isNew])).toEqual([["a", true], ["b", false]]);
  });

  it("記事の地点を sortOrder の順に並べ、各訪問に順番と地点数を付ける", () => {
    const d = buildPlaceMapData([row("x", { articles: [art("A", 2)] }), row("y", { articles: [art("A", 1)] })], now);
    expect(d.articles).toEqual([expect.objectContaining({ shortId: "A", places: ["y", "x"] })]);
    expect(d.places.find((p) => p.id === "x")!.visits[0]).toMatchObject({ order: 2, total: 2 });
  });

  it("記事の日付は JST の日付にする", () => {
    const d = buildPlaceMapData([row("x", { articles: [art("A", 0, "2026-10-28T15:30:00.000Z")] })], now);
    expect(d.articles[0].date).toBe("2026-10-29");
  });

  it("エリアは件数の多い順、未設定は「その他」にまとめて最後", () => {
    const d = buildPlaceMapData([row("1"), row("2"), row("3", { area: "名古屋" }), row("4", { area: "東京" }), row("5", { area: "東京" })], now);
    expect(d.areas).toEqual(["東京", "名古屋", "その他"]);
    expect(d.places[0]).toMatchObject({ area: "その他", areaUnset: true, kind: "unset" });
  });
});
