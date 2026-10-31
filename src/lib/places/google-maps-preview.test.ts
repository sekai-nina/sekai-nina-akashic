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
    const r = await addCardPreviews(body, fake);
    expect(r.added).toBe(1);
    expect(r.body).toContain(
      card("https://maps.app.goo.gl/a", ["lat: 1", "lng: 2", `image: ${PHOTO}`, "description: \"〒1 '東京'\""])
    );
    expect(r.body).toContain(card("https://maps.app.goo.gl/nophoto"));
    expect(fetched.sort()).toEqual(["https://maps.app.goo.gl/a", "https://maps.app.goo.gl/nophoto"]);
  });

  it("カードが無ければ取りに行かない", async () => {
    fetched.length = 0;
    expect(await addCardPreviews("本文だけ", fake)).toEqual({ body: "本文だけ", added: 0 });
    expect(fetched).toEqual([]);
  });
});
