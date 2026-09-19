import { describe, expect, it } from "vitest";

import {
  articleTitleFor,
  normalizeTweetUrl,
  renderMeetGreetArticle,
  type ArticleAssetInput,
  type RenderArticleInput,
} from "./article";
import { planAppend } from "./append";

const BLOG_URL = "https://www.hinatazaka46.com/s/official/diary/detail/70435";
const STAFF_URL = "https://www.hinatazaka46.com/s/official/diary/manager/list?ima=0000#article-1";

const asset = (over: Partial<ArticleAssetInput> & { id: string }): ArticleAssetInput => ({
  kind: "image",
  title: over.id,
  canonicalDate: "2026-08-03",
  sortAt: "2026-08-03T07:20:00.000Z",
  source: null,
  excerpts: [],
  ...over,
});

const blogText = asset({
  id: "blog-text",
  kind: "text",
  title: "坂井新奈ブログ「待ち合わせ」",
  source: { kind: "url", title: "坂井新奈ブログ「待ち合わせ」", url: BLOG_URL, publishedAt: "2026-08-03" },
  excerpts: ["浴衣でした\n\n挑戦！"],
});
const blogImage = (n: number) =>
  asset({
    id: `blog-img-${n}`,
    title: `坂井新奈ブログ「待ち合わせ」 (${n}/3)`,
    source: { kind: "url", title: "坂井新奈ブログ「待ち合わせ」", url: BLOG_URL, publishedAt: "2026-08-03" },
  });
const talk = (id: string, hhmm: string, kind: ArticleAssetInput["kind"] = "image") =>
  asset({
    id,
    kind,
    title: `坂井新奈トーク 2026.8.2 ${hhmm}`,
    canonicalDate: "2026-08-02",
    sortAt: `2026-08-02T${hhmm.padStart(5, "0")}:00.000Z`,
    source: { kind: "other", title: "Talk メッセージ #1", url: null, publishedAt: null },
  });

const input = (over: Partial<RenderArticleInput> = {}): RenderArticleInput => ({
  date: "2026-08-01",
  format: "real",
  venue: "幕張メッセ",
  single: "17thシングル「Kind of love」",
  assets: [blogImage(2), blogImage(1), blogText, talk("t-late", "16:24"), talk("t-early", "13:15")],
  reports: ["https://x.com/aaa/status/111"],
  tiktoks: [],
  thumbnailUrl: "https://r2.example/sketch.png",
  dossier: { id: "dsr1", updatedAt: "2026-08-12T01:09:19.304Z", itemCount: 5 },
  today: "2026-08-12",
  ...over,
});

describe("articleTitleFor", () => {
  it("リアルは会場名を括弧で添える", () => {
    expect(articleTitleFor({ date: "2026-08-01", format: "real", venue: "幕張メッセ" })).toBe(
      "2026年8月1日 リアルミーグリ（幕張メッセ）"
    );
  });

  it("オンラインは会場名を出さない", () => {
    expect(articleTitleFor({ date: "2026-08-09", format: "online", venue: "幕張" })).toBe(
      "2026年8月9日 オンラインミーグリ"
    );
  });

  it("会場が無ければ括弧ごと出さない", () => {
    expect(articleTitleFor({ date: "2026-08-01", format: "real", venue: null })).toBe(
      "2026年8月1日 リアルミーグリ"
    );
  });
});

describe("renderMeetGreetArticle", () => {
  it("出典はブログ (日付昇順) → トーク (時系列) の順に採番する", () => {
    const r = renderMeetGreetArticle(input());
    expect(r.sources.map((s) => s.sourceNo)).toEqual([1, 2, 3]);
    expect(r.sources[0].assetId).toBe("blog-text"); // ブログの ref は本文アセット
    // トークは sortAt 順 (入力順ではない)
    expect(r.sources[1].label).toContain("13:15");
    expect(r.sources[2].label).toContain("16:24");
  });

  it("本文の ^[n] は必ず出典に宛先がある", () => {
    const r = renderMeetGreetArticle(input());
    const refs = [...r.body.matchAll(/\^\[(\d+)\]/g)].map((m) => Number(m[1]));
    const known = new Set(r.sources.map((s) => s.sourceNo));
    expect(refs.length).toBeGreaterThan(0);
    for (const n of refs) expect(known.has(n)).toBe(true);
  });

  it("ブログ画像は (n/N) の数値順に並べる", () => {
    const r = renderMeetGreetArticle(input());
    const lines = r.parts.blogImages.map((b) => b.line);
    expect(lines[0]).toContain("(1/3)");
    expect(lines[1]).toContain("(2/3)");
  });

  it("トークの種別は asset.kind で出し分ける", () => {
    const r = renderMeetGreetArticle(
      input({ assets: [talk("t1", "13:15", "video"), talk("t2", "16:24", "image")] })
    );
    expect(r.body).toContain("【トーク・動画】");
    expect(r.body).toContain("【トーク・画像】");
  });

  it("CRLF の抜粋でも行末に \\r を残さない", () => {
    const r = renderMeetGreetArticle(
      input({ assets: [{ ...blogText, excerpts: ["一行目\r\n\r\n二行目"] }] })
    );
    expect(r.body).not.toContain("\r");
    expect(r.body).toContain("> 一行目");
    expect(r.body).toContain("> 二行目");
  });

  it("frontmatter は対面 / オンライン表記 (タイトルのリアルとは別)", () => {
    expect(renderMeetGreetArticle(input()).frontmatterExtra.meetgreet.format).toBe("対面");
    expect(
      renderMeetGreetArticle(input({ format: "online" })).frontmatterExtra.meetgreet.format
    ).toBe("オンライン");
  });

  it("サムネが無ければ outfit_image も img も出さない", () => {
    const r = renderMeetGreetArticle(input({ thumbnailUrl: null }));
    expect(r.frontmatterExtra.meetgreet.outfit_image).toBeUndefined();
    expect(r.body).not.toContain("<img");
  });

  it("シングル名が空なら frontmatter に出さない", () => {
    expect(renderMeetGreetArticle(input({ single: "" })).frontmatterExtra.meetgreet.single).toBeUndefined();
  });

  describe("ひなたぼっこ日記 (運営ブログ)", () => {
    const staffText = asset({
      id: "staff-text",
      kind: "text",
      title: "花火でも見に行く？",
      canonicalDate: "2026-08-09",
      source: { kind: "url", title: "花火でも見に行く？", url: STAFF_URL, publishedAt: "2026-08-09" },
      excerpts: ["運営が書いた文章"],
    });
    const staffImage = asset({
      id: "staff-img",
      title: "花火でも見に行く？ (1/4)",
      canonicalDate: "2026-08-09",
      source: { kind: "url", title: "花火でも見に行く？", url: STAFF_URL, publishedAt: "2026-08-09" },
    });

    it("抜粋があっても「本人の感想」には載せない", () => {
      const r = renderMeetGreetArticle(input({ assets: [staffText] }));
      expect(r.body).not.toContain("## 本人の感想（ブログより）");
      expect(r.body).not.toContain("運営が書いた文章");
    });

    it("出典ラベルに正式名称を添える", () => {
      const r = renderMeetGreetArticle(input({ assets: [staffText] }));
      expect(r.sources[0].label).toBe("ひなたぼっこ日記「花火でも見に行く？」");
    });

    it("画像だけのときは導入文も切り替える", () => {
      const r = renderMeetGreetArticle(input({ assets: [staffImage] }));
      expect(r.body).toContain("ひなたぼっこ日記に、当日前後の写真が掲載されている。");
      expect(r.body).toContain("【ひなたぼっこ日記・画像】");
    });
  });
});

describe("生成 → 追記の往復", () => {
  // 組み立てと追記は別々に育つので、同じ入力で追記が何も増やさないことを固定する。
  // 片方だけ表記が変わると (URL の正規化・見出しの空行など) ここが落ちる
  it("同じ材料なら追記は何も増やさない", () => {
    const r = renderMeetGreetArticle(input());
    const plan = planAppend({
      existingBody: r.body,
      parts: r.parts,
      sources: r.sources,
      existingSources: r.sources.map((s) => ({
        sourceNo: s.sourceNo,
        assetId: s.assetId,
        url: s.url,
      })),
    });
    expect(plan.added).toEqual({ quotes: 0, reports: 0, talks: 0, blogImages: 0, tiktoks: 0 });
    expect(plan.newSources).toHaveLength(0);
    expect(plan.empty).toBe(true);
    expect(plan.body).toBe(r.body);
  });

  it("TikTok とレポを含む構成でも往復で増えない", () => {
    const r = renderMeetGreetArticle(
      input({
        reports: ["https://x.com/aaa/status/111", "https://x.com/bbb/status/222"],
        tiktoks: ["https://www.tiktok.com/@u/video/7123456789"],
      })
    );
    const plan = planAppend({
      existingBody: r.body,
      parts: r.parts,
      sources: r.sources,
      existingSources: r.sources.map((s) => ({ sourceNo: s.sourceNo, assetId: s.assetId, url: s.url })),
    });
    expect(plan.empty).toBe(true);
  });

  it("レポの URL 表記が揺れても重複追記しない", () => {
    // 記事には www 付きで載っているが、ドシエ側は www 無し (実データで起きる)
    const r = renderMeetGreetArticle(input({ reports: ["https://www.x.com/aaa/status/111"] }));
    const plan = planAppend({
      existingBody: r.body,
      parts: { ...r.parts, reports: ["https://x.com/aaa/status/111?s=20"] },
      sources: r.sources,
      existingSources: r.sources.map((s) => ({ sourceNo: s.sourceNo, assetId: s.assetId, url: s.url })),
    });
    expect(plan.added.reports).toBe(0);
  });
});

describe("normalizeTweetUrl", () => {
  it("www / twitter.com / クエリ / 末尾スラッシュを吸収する", () => {
    const want = "https://x.com/aaa/status/111";
    for (const u of [
      "https://x.com/aaa/status/111",
      "https://www.x.com/aaa/status/111",
      "https://twitter.com/aaa/status/111",
      "https://www.twitter.com/aaa/status/111/",
      "https://x.com/aaa/status/111?s=20",
    ]) {
      expect(normalizeTweetUrl(u)).toBe(want);
    }
  });
});
