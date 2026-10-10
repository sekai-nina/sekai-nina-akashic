import { describe, expect, it } from "vitest";
import { countSiteQuotes, listQuotePassages, setPassageQuoted } from "./featured-passages";

// テンプレート (quote-blog.ts) が書く形: リード + 抜粋ごとの引用ブロック
const TEMPLATE_BODY = [
  "坂井新奈ブログでの名言を紹介する。",
  "",
  "> 一行目",
  "> 二行目",
  "",
  "> 別の抜粋",
  "",
].join("\n");

// 既存記事の形: `>` の直後に空白なし、ブロックの途中から手で付けた {q}
const MANUAL_BODY = [
  "坂井新奈ブログでの名言を紹介する。",
  "",
  ">前置き、",
  ">{q}選んだ一節",
  ">続き{/q}",
  "",
  ">次のブロック",
].join("\n");

describe("listQuotePassages", () => {
  it("引用の段落を区切る", () => {
    const ps = listQuotePassages(TEMPLATE_BODY);
    expect(ps.map((p) => p.text)).toEqual(["一行目\n二行目", "別の抜粋"]);
    expect(ps.every((p) => !p.quoted)).toBe(true);
  });

  it("空行でブロックが切れ、手で付けた範囲を segments に出す", () => {
    const ps = listQuotePassages(MANUAL_BODY);
    expect(ps).toHaveLength(2);
    expect(ps[0].quoted).toBe(true);
    expect(ps[0].text).toBe("前置き、\n選んだ一節\n続き");
    expect(ps[0].segments).toEqual([
      { text: "前置き、\n", quoted: false },
      { text: "選んだ一節\n続き", quoted: true },
    ]);
    expect(ps[1].quoted).toBe(false);
  });

  it("`>` だけの行ではブロックを切らない (抜粋の中の段落をまたぐ {q} を壊さない)", () => {
    const body = "> {q}一つ目\n> \n> 二つ目{/q}\n";
    const ps = listQuotePassages(body);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ quoted: true, unbalanced: false, text: "一つ目\n\n二つ目" });
    expect(setPassageQuoted(body, 0, false)).toBe("> 一つ目\n> \n> 二つ目\n");
  });

  it("CRLF の本文も読める", () => {
    expect(listQuotePassages("> 一\r\n> 二\r\n").map((p) => p.text)).toEqual(["一\n二"]);
  });

  it("閉じが先に来るブロックは数が合っていても unbalanced", () => {
    expect(listQuotePassages(">a{/q}b{q}c")[0].unbalanced).toBe(true);
  });

  it("ブロックをまたぐマーカーは unbalanced", () => {
    const body = ">{q}一つ目\n\n>二つ目{/q}";
    const ps = listQuotePassages(body);
    expect(ps.map((p) => p.unbalanced)).toEqual([true, true]);
  });
});

describe("setPassageQuoted", () => {
  it("ブロック全体を包み、外すと元に戻る", () => {
    const on = setPassageQuoted(TEMPLATE_BODY, 0, true)!;
    expect(on).toContain("> {q}一行目\n> 二行目{/q}");
    expect(countSiteQuotes(on)).toBe(1);
    expect(setPassageQuoted(on, 0, false)).toBe(TEMPLATE_BODY);
  });

  it("一部が載っている段落に on しても手の範囲を変えない", () => {
    expect(setPassageQuoted(MANUAL_BODY, 0, true)).toBe(MANUAL_BODY);
  });

  it("off は段落の中のマーカーをすべて外す (id 付きも)", () => {
    const body = '>{q id="a"}x{/q}と{q}y{/q}';
    expect(setPassageQuoted(body, 0, false)).toBe(">xとy");
  });

  it("画面に出した本文と食い違えば null", () => {
    expect(setPassageQuoted(TEMPLATE_BODY, 0, true, "一行目\n二行目")).not.toBeNull();
    expect(setPassageQuoted(TEMPLATE_BODY, 0, true, "別の抜粋")).toBeNull();
  });

  it("無い段落・閉じていない段落は null", () => {
    expect(setPassageQuoted(TEMPLATE_BODY, 5, true)).toBeNull();
    expect(setPassageQuoted(">{q}一つ目\n\n>二つ目{/q}", 0, false)).toBeNull();
  });
});

describe("countSiteQuotes", () => {
  it("サイトと同じく空の {q}{/q} を数えない", () => {
    expect(countSiteQuotes(MANUAL_BODY)).toBe(1);
    expect(countSiteQuotes(">{q} {/q}")).toBe(0);
  });
});
