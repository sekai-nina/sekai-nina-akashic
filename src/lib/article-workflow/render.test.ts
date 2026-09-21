import { describe, expect, it } from "vitest";

import { classifyMaterials, isBlogAssetTitle, numberSources, type ArticleAssetInput } from "./render";

const asset = (over: Partial<ArticleAssetInput> & { id: string }): ArticleAssetInput => ({
  kind: "text",
  title: over.id,
  canonicalDate: "2025-11-11",
  sortAt: "2025-11-11T10:00:00.000Z",
  source: null,
  excerpts: [],
  ...over,
});

describe("classifyMaterials の出典ラベル", () => {
  it("出典の題が素のブログ題でも、アセットの題が「〜ブログ「…」」ならそちらを使う (誰のブログか分かる)", () => {
    const url = "https://www.hinatazaka46.com/s/official/diary/detail/66627";
    const { blogs } = classifyMaterials([
      // 古い取り込み: 出典の題は「自分を変える」だけ
      asset({ id: "img", kind: "image", title: "高井俐香ブログ「自分を変える」 (1/2)", source: { kind: "url", title: "自分を変える", url, publishedAt: "2025-11-11" } }),
      asset({ id: "text", title: "高井俐香ブログ「自分を変える」", source: { kind: "url", title: "自分を変える", url, publishedAt: "2025-11-11" } }),
    ]);
    expect(blogs).toHaveLength(1);
    expect(numberSources(blogs, []).sources[0].label).toBe("高井俐香ブログ「自分を変える」");
    expect(blogs[0].ref).toBe("text");
  });

  it("新しい取り込み (出典の題も「坂井新奈ブログ「…」」) はそのまま", () => {
    const url = "https://www.hinatazaka46.com/s/official/diary/detail/69643";
    const { blogs } = classifyMaterials([
      asset({ id: "text", title: "坂井新奈ブログ「🍈🫧」", source: { kind: "url", title: "坂井新奈ブログ「🍈🫧」", url, publishedAt: "2026-06-04" } }),
    ]);
    expect(numberSources(blogs, []).sources[0].label).toBe("坂井新奈ブログ「🍈🫧」");
  });

  it("ひなたぼっこ日記の本文アセットの題が「〜ブログ「…」」でも二重に包まない", () => {
    const url = "https://www.hinatazaka46.com/s/official/diary/manager/list?ima=0000#article-2";
    const { blogs } = classifyMaterials([
      asset({ id: "text", title: "運営ブログ「集合」", source: { kind: "url", title: "集合", url, publishedAt: "2026-08-01" } }),
    ]);
    expect(numberSources(blogs, []).sources[0].label).toBe("ひなたぼっこ日記「集合」");
  });

  it("ひなたぼっこ日記 (画像だけ) は今までどおり運営ブログの名前を付ける", () => {
    const url = "https://www.hinatazaka46.com/s/official/diary/manager/list?ima=0000#article-1";
    const { blogs } = classifyMaterials([
      asset({ id: "img", kind: "image", title: "花火でも見に行く？🎆 (1/4)", source: { kind: "url", title: "花火でも見に行く？🎆", url, publishedAt: "2026-08-01" } }),
    ]);
    expect(numberSources(blogs, []).sources[0].label).toBe("ひなたぼっこ日記「花火でも見に行く？🎆」");
  });
});

describe("isBlogAssetTitle", () => {
  it("メンバー名 + ブログ「題」の形だけ", () => {
    expect(isBlogAssetTitle("坂井新奈ブログ「だいすき！」")).toBe(true);
    expect(isBlogAssetTitle("高井俐香ブログ「自分を変える」")).toBe(true);
    expect(isBlogAssetTitle("坂井新奈ブログ「待ち合わせ」 (1/3)")).toBe(false);
    expect(isBlogAssetTitle("自分を変える")).toBe(false);
  });
});
