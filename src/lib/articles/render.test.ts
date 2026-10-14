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
