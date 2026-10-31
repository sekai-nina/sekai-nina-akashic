import { describe, expect, it } from "vitest";
import { addCardPreviews, parseGoogleMapsPreview } from "./google-maps-preview";

const PHOTO = "https://lh3.googleusercontent.com/grass-cs/AAA=w900-h900-p-k-no";

describe("parseGoogleMapsPreview", () => {
  it("ボット向けページの og:image と og:title の住所を取る", () => {
    const html = `<meta content="Eggs &#39;n Things · 〒135-0061 東京都江東区豊洲２丁目４−９" property="og:title"><meta content="${PHOTO.replace(/&/g, "&amp;")}" property="og:image">`;
    expect(parseGoogleMapsPreview(html)).toEqual({
      image: "https://lh3.googleusercontent.com/grass-cs/AAA=w320-h200-p-k-no",
      address: "〒135-0061 東京都江東区豊洲２丁目４−９",
    });
  });

  it("縮められない形の写真 (ストリートビュー) はそのまま", () => {
    const sv = "https://lh3.googleusercontent.com/gpms-cs-s/BBB=w900-h600-k-no-pi-19.2-ya350.93-ro0-fo100";
    expect(parseGoogleMapsPreview(`<meta content="${sv}" property="og:image">`).image).toBe(sv);
  });

  it("静的地図 (API キー入り) と住所の無いタイトルは使わない", () => {
    const html =
      '<meta content="Google Maps" property="og:title"><meta content="https://maps.google.com/maps/api/staticmap?center=1,2&amp;key=x" property="og:image">';
    expect(parseGoogleMapsPreview(html)).toEqual({ image: null, address: null });
  });
});

describe("addCardPreviews", () => {
  const card = (url: string, extra: string[] = []) =>
    ["```cardlink", `url: ${url}`, 'title: "店"', "host: maps.app.goo.gl", ...extra, "```"].join("\n");
  const fetched: string[] = [];
  const fake = async (url: string) => {
    fetched.push(url);
    return url.includes("nophoto") ? { image: null, address: "住所" } : { image: PHOTO, address: '〒1 "東京"' };
  };

  it("写真の無い Google マップのカードに写真と住所を足す。ほかは触らない", async () => {
    fetched.length = 0;
    const body = [
      "本文",
      card("https://maps.app.goo.gl/a", ["lat: 1", "lng: 2"]),
      card("https://maps.app.goo.gl/nophoto"),
      card("https://maps.app.goo.gl/has", [`image: ${PHOTO}`]),
      card("https://example.com/x"),
    ].join("\n\n");
    const r = await addCardPreviews(body, { fetchPreview: fake });
    expect(r.added).toBe(1);
    expect(r.body).toContain(
      card("https://maps.app.goo.gl/a", ["lat: 1", "lng: 2", `image: ${PHOTO}`, "description: \"〒1 '東京'\""])
    );
    expect(r.body).toContain(card("https://maps.app.goo.gl/nophoto"));
    expect(fetched.sort()).toEqual(["https://maps.app.goo.gl/a", "https://maps.app.goo.gl/nophoto"]);
  });

  it("before にもうあったカードは触らない (追記・組み込みで古いカードを書き換えない)", async () => {
    fetched.length = 0;
    const old = card("https://maps.app.goo.gl/old");
    const r = await addCardPreviews(`${old}\n\n${card("https://maps.app.goo.gl/new")}`, { before: old, fetchPreview: fake });
    expect(r.added).toBe(1);
    expect(r.body.startsWith(`${old}\n`)).toBe(true);
    expect(fetched).toEqual(["https://maps.app.goo.gl/new"]);
  });

  it("住所の改行は空白に詰める", () => {
    const html = '<meta content="店 · 〒1&#10;東京" property="og:title">';
    expect(parseGoogleMapsPreview(html).address).toBe("〒1 東京");
  });

  it("カードが無ければ取りに行かない", async () => {
    fetched.length = 0;
    expect(await addCardPreviews("本文だけ", { fetchPreview: fake })).toEqual({ body: "本文だけ", added: 0 });
    expect(fetched).toEqual([]);
  });
});
