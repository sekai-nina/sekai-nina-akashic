import { describe, expect, it } from "vitest";
import { renderArticleBody } from "./render";

// 公開サイトがクライアント JS でしている変換をサーバー側で揃えたもの
describe("renderArticleBody: 公開サイトと見た目を揃える変換", () => {
  it("脚注は公開サイトと同じ class と [n] 表記", async () => {
    const html = await renderArticleBody("本文^[3]");
    expect(html).toContain('<sup class="footnote-ref"><a class="footnote-link" href="#src-3" data-source-no="3">[3]</a></sup>');
  });

  it("wikilink は internal-link / broken-link を併せ持つ", async () => {
    const html = await renderArticleBody("[[ある記事]] と [[無い記事]]", { wikilinks: new Map([["ある記事", "abc"]]) });
    expect(html).toContain('<a class="wikilink internal-link" href="/articles/abc">ある記事</a>');
    expect(html).toContain('class="wikilink wikilink-missing broken-link"');
  });

  it("表のセルの - 行は箇条書きになる", async () => {
    const md = "| # | 補足 |\n| - | - |\n| 1 | - あ<br>- い |\n| 2 | ふつう |\n";
    const html = await renderArticleBody(md);
    expect(html).toContain("<td><ul><li>あ</li><li>い</li></ul></td>");
    expect(html).toContain("<td>ふつう</td>");
  });

  it("出典と同じ URL のリンクに source-ref-link を付ける", async () => {
    const html = await renderArticleBody("[A](https://ex/a) [B](https://ex/b)", { sourceUrls: ["https://ex/a", null] });
    expect(html).toContain('<a href="https://ex/a" class="source-ref-link">A</a>');
    expect(html).toContain('<a href="https://ex/b">B</a>');
  });
});

describe("renderArticleBody: 聖地のカードの地図サムネイル", () => {
  const card = (extra: string) =>
    ["```cardlink", "url: https://maps.app.goo.gl/x", 'title: "リズラボキッチン"', "host: maps.app.goo.gl", extra, "```"].join("\n");

  it("lat / lng があればピン付きの地図を出し、タイルの位置はサニタイズを通る", async () => {
    const html = await renderArticleBody(card("lat: 35.6595\nlng: 139.7005"));
    expect(html).toContain('class="cardlink-image cardlink-map"');
    expect(html).toContain('<span class="cardlink-pin"></span>');
    expect(html).toMatch(/<img src="https:\/\/tile\.openstreetmap\.org\/16\/\d+\/\d+\.png" alt="" class="cardlink-tile" loading="lazy" style="left:-?\d+px;top:-?\d+px">/);
  });

  it("写真 (image) があれば地図より写真。住所 (description) をタイトルの下に出す", async () => {
    const html = await renderArticleBody(card('lat: 35.6\nlng: 139.7\nimage: https://lh3.googleusercontent.com/p=w900\ndescription: "〒150-0001 東京都渋谷区"'));
    expect(html).toContain('<div class="cardlink-image"><img src="https://lh3.googleusercontent.com/p=w900" alt="" loading="lazy"></div>');
    expect(html).not.toContain("cardlink-map");
    expect(html).toContain('<div class="cardlink-description">〒150-0001 東京都渋谷区</div>');
  });

  it("座標が無い・壊れているカードは画像なしのまま", async () => {
    for (const extra of ["", "lat: abc\nlng: 139.7", "lat: 35.6"]) {
      const html = await renderArticleBody(card(extra));
      expect(html).toContain('class="cardlink"');
      expect(html).not.toContain("cardlink-map");
    }
  });

  it("本文の生 HTML の style は left / top の形以外落とす", async () => {
    const html = await renderArticleBody('<img src="https://ex/a.png" style="position:fixed;inset:0">\n\n<p style="left:1px;top:1px">x</p>');
    expect(html).not.toContain("position:fixed");
    expect(html).not.toContain("style=");
  });
});

describe("renderArticleBody: ほぼ確定の訪問のカード (#333)", () => {
  const card = ["```cardlink", "url: https://maps.app.goo.gl/x", 'title: "神社"', "host: maps.app.goo.gl", "place_id: p1", "```"].join("\n");

  it("locations で likely の聖地のカードに印を付け、カードの下に理由を出す", async () => {
    const html = await renderArticleBody(card, {
      locations: [{ place_id: "p1", certainty: "likely", certainty_note: "おみくじを引いたとだけ <b>" }],
    });
    expect(html).toContain('<div class="cardlink-group">');
    expect(html).toContain('<div class="cardlink-meta"><span class="cardlink-certainty">ほぼ確定</span>');
    expect(html).toContain('<div class="cardlink-certainty-note"><span class="cardlink-certainty">ほぼ確定</span>おみくじを引いたとだけ &#x3C;b></div>');
  });

  it("確定・locations に無い聖地・place_id の無いカードは印なし", async () => {
    for (const locations of [[{ place_id: "p1" }], [{ place_id: "p2", certainty: "likely" }], []]) {
      const html = await renderArticleBody(card, { locations });
      expect(html).not.toContain("cardlink-certainty");
    }
  });

  it("理由が無ければ印だけ (カードの下の行は出さない)", async () => {
    const html = await renderArticleBody(card, { locations: [{ place_id: "p1", certainty: "likely" }] });
    expect(html).toContain('<span class="cardlink-certainty">ほぼ確定</span>');
    expect(html).not.toContain("cardlink-certainty-note");
  });
});

