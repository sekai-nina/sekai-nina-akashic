import { describe, expect, it } from "vitest";

import { buildMaterialsText } from "./materials";
import {
  classifyMaterials,
  isBlogAssetTitle,
  numberSources,
  quotedBlogs,
  renderRelatedMediaSection,
  type ArticleAssetInput,
} from "./render";

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

describe("URL 付きの番組・動画・音声の素材", () => {
  const video: ArticleAssetInput = {
    id: "video",
    kind: "video",
    title: "【ガチ検証】わらしべ長者",
    canonicalDate: "2026-02-10",
    sortAt: "2026-02-10T10:00:00.000Z",
    source: { kind: "url", title: "【ガチ検証】わらしべ長者", url: "https://www.youtube.com/watch?v=x", publishedAt: "2026-02-10" },
    excerpts: ["柔道着を持ってきました"],
    text: "文字起こしの本文",
    notes: ["人のメモ"],
  };
  const materials = (assets: ArticleAssetInput[]) =>
    buildMaterialsText({
      dossier: { id: "d1", title: "柔道着", updatedAt: "2026-11-05T00:00:00.000Z", itemCount: assets.length },
      assets,
      reports: [],
      tiktoks: [],
      thumbnailUrl: null,
      places: [],
      today: "2026-11-05",
    });

  it("関連メディアの行はブログ画像と名乗らず、抜粋は引用にしない", () => {
    const { blogs, talks } = classifyMaterials([video]);
    const { talkSourceNo, sources } = numberSources(blogs, talks);
    expect(sources[0]).toMatchObject({ sourceNo: 1, assetId: "video", url: "https://www.youtube.com/watch?v=x" });
    expect(renderRelatedMediaSection({ talks, blogs, tiktoks: [], talkSourceNo, style: { kind: "flat" } })).toContain(
      "- 【動画】【ガチ検証】わらしべ長者^[1]"
    );
    expect(quotedBlogs(blogs)).toEqual([]);
  });

  it("ミーグリの形でも、写真の無い章に写真の導入文を書かない", () => {
    const { blogs, talks } = classifyMaterials([video]);
    const { talkSourceNo } = numberSources(blogs, talks);
    expect(renderRelatedMediaSection({ talks, blogs, tiktoks: [], talkSourceNo }).join("\n")).not.toContain("写真");
  });

  it("文字起こし・抜粋・メモを AI の素材に 1 回ずつ入れる", () => {
    const m = materials([video]);
    expect(m.included).toBe(1);
    expect(m.text).toContain("文字起こしの本文");
    expect(m.text).toContain("> 柔道着を持ってきました");
    expect(m.text.match(/人のメモ\n/g)).toHaveLength(1);
    expect(m.text).not.toContain("画像だけのブログ");
  });

  it("同じ URL の本文・画像・前後編があっても、どの本文も落とさない", () => {
    const part2 = { ...video, id: "video2", title: "後編", text: "後編の文字起こし", excerpts: [], notes: [] };
    const image = { ...video, id: "image", kind: "image" as const, title: "サムネ", text: null, excerpts: [], notes: [] };
    const text = { ...video, id: "text", kind: "text" as const, title: "説明", text: "動画の説明", excerpts: [], notes: [] };
    const m = materials([image, video, part2, text]);
    expect(m.included).toBe(1);
    for (const body of ["文字起こしの本文", "後編の文字起こし", "動画の説明"]) expect(m.text).toContain(body);
    expect(classifyMaterials([image, video]).blogs[0].ref).toBe("video");
    expect(classifyMaterials([image, video, text]).blogs[0].ref).toBe("text");
  });

  it("本文の無い動画は動画の素材と書く", () => {
    const m = materials([{ ...video, text: null, excerpts: [], notes: [] }]);
    expect(m.text).toContain("(本文なし。動画の素材)");
    expect(m.included).toBe(0);
  });
});
