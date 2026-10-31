import { describe, expect, it } from "vitest";
import {
  findWikiLinkQuery,
  rankWikiLinkCandidates,
  wikiLinkInsertion,
  type WikiLinkCandidate,
} from "./wiki-link-complete";

const c = (title: string): WikiLinkCandidate => ({ title, type: null, draft: false, unlisted: false });

describe("findWikiLinkQuery", () => {
  it("書きかけの [[ を拾う", () => {
    expect(findWikiLinkQuery("初出は[[お披")).toEqual({ from: 5, query: "お披" });
  });
  it("[[ の直後 (空の問い合わせ) も拾う", () => {
    expect(findWikiLinkQuery("初出は[[")).toEqual({ from: 5, query: "" });
  });
  it("閉じ済みのリンクの後ろでは拾わない", () => {
    expect(findWikiLinkQuery("[[A]] のあと")).toBeNull();
  });
  it("表示名を書いている間は拾わない", () => {
    expect(findWikiLinkQuery("[[A|あの")).toBeNull();
  });
  it("[[ が無ければ拾わない", () => {
    expect(findWikiLinkQuery("ふつうの文 [リンク")).toBeNull();
  });
  it("閉じたリンクの後ろに新しく書きかけたものは拾う", () => {
    expect(findWikiLinkQuery("[[A]] と [[B")).toEqual({ from: 10, query: "B" });
  });
});

describe("rankWikiLinkCandidates", () => {
  const all = [c("お披露目ライブ"), c("初のお披露目"), c("お披露目での自己紹介"), c("ハリー・ポッターが好き")];

  it("部分一致で、前方一致 → 短い順に並べる", () => {
    expect(rankWikiLinkCandidates(all, "お披露目").map((x) => x.title)).toEqual([
      "お披露目ライブ",
      "お披露目での自己紹介",
      "初のお披露目",
    ]);
  });
  it("全角・半角や大文字小文字の違いを無視する", () => {
    expect(rankWikiLinkCandidates([c("ＭＶ撮影"), c("mv 撮影")], "mv").map((x) => x.title)).toEqual([
      "ＭＶ撮影",
      "mv 撮影",
    ]);
  });
  it("空の問い合わせは全件をタイトル順に返す", () => {
    expect(rankWikiLinkCandidates(all, "")).toHaveLength(4);
  });
  it("件数を絞る", () => {
    expect(rankWikiLinkCandidates(all, "お", 2)).toHaveLength(2);
  });
});

describe("wikiLinkInsertion", () => {
  it("タイトルと閉じ括弧を入れる", () => {
    expect(wikiLinkInsertion("A", "である")).toEqual({ insert: "A]]", consumeAfter: 0 });
  });
  it("直後の ]] は重ねない", () => {
    expect(wikiLinkInsertion("A", "]]である")).toEqual({ insert: "A]]", consumeAfter: 2 });
  });
  it("既存リンクの途中で選んだら ]] までを置き換える", () => {
    expect(wikiLinkInsertion("A", "タイトル]]である")).toEqual({ insert: "A]]", consumeAfter: 6 });
  });
  it("表示名付きのリンクの途中ではタイトルだけ置き換えて表示名を残す", () => {
    expect(wikiLinkInsertion("A", "ル|表示]]")).toEqual({ insert: "A", consumeAfter: 1 });
  });
  it("別の [[ が先に来るなら食わない", () => {
    expect(wikiLinkInsertion("A", " と [[B]]")).toEqual({ insert: "A]]", consumeAfter: 0 });
  });
});
