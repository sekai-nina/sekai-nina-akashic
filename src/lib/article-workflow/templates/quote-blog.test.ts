import { describe, expect, it } from "vitest";

import { TemplateInputError } from "../errors";
import type { ArticleAssetInput } from "../render";
import { QUOTE_BLOG_TEMPLATE, quoteBlogTitle, renderQuoteBlogArticle } from "./quote-blog";
import type { DossierRenderInput } from "./types";
import { planAppend } from "@/lib/meetgreet/append";

const BLOG_URL = "https://www.hinatazaka46.com/s/official/diary/detail/66852";
const STAFF_URL = "https://www.hinatazaka46.com/s/official/diary/manager/list?ima=0000#article-1";

const asset = (over: Partial<ArticleAssetInput> & { id: string }): ArticleAssetInput => ({
  kind: "text",
  title: over.id,
  canonicalDate: "2025-11-27",
  sortAt: "2025-11-27T10:00:00.000Z",
  source: null,
  excerpts: [],
  ...over,
});

const blog = (excerpts: string[], over: Partial<ArticleAssetInput> = {}) =>
  asset({
    id: "blog-text",
    title: "坂井新奈ブログ「だいすき！」",
    source: { kind: "url", title: "坂井新奈ブログ「だいすき！」", url: BLOG_URL, publishedAt: "2025-11-27" },
    excerpts,
    ...over,
  });

const input = (assets: ArticleAssetInput[]): DossierRenderInput => ({
  dossier: { id: "d1", title: "言葉_blog_20251127", updatedAt: "2026-09-22T00:00:00.000Z", itemCount: assets.length },
  assets,
  reports: [],
  tiktoks: [],
  thumbnailUrl: null,
  places: [],
  today: "2026-09-22",
});

describe("quoteBlogTitle", () => {
  it("本人ブログのタイトルから「ブログ「X」」にする", () => {
    expect(quoteBlogTitle("坂井新奈ブログ「包まれて」")).toBe("ブログ「包まれて」");
    expect(quoteBlogTitle("坂井新奈ブログ「白い彗星 坂井新奈」 ")).toBe("ブログ「白い彗星 坂井新奈」");
  });
  it("パターン外はそのまま", () => {
    expect(quoteBlogTitle("坂井新奈トーク 2026.5.5 15:15")).toBe("坂井新奈トーク 2026.5.5 15:15");
    expect(quoteBlogTitle("")).toBe("無題");
  });
});

describe("renderQuoteBlogArticle", () => {
  it("リード 1 文 + 抜粋の引用ブロック + 出典 1 件 (既存の quote 記事と同じ形)", () => {
    const r = renderQuoteBlogArticle(input([blog(["本当に本当にありがとうございました\n人の温かさで涙がでる", "なんでこんなにも一瞬なんだろう"])]));
    expect(r.title).toBe("ブログ「だいすき！」");
    expect(r.body).toBe(
      [
        "坂井新奈ブログでの名言を紹介する。",
        "",
        "> 本当に本当にありがとうございました",
        "> 人の温かさで涙がでる",
        "",
        "> なんでこんなにも一瞬なんだろう",
        "",
      ].join("\n")
    );
    expect(r.sources).toEqual([
      { sourceNo: 1, url: BLOG_URL, label: "坂井新奈ブログ「だいすき！」", date: "2025-11-27", assetId: "blog-text" },
    ]);
    expect(r.tags).toEqual([]);
    expect(r.dates).toEqual({ date: null, dateDisplay: null, dateMode: null });
    expect(r.draft).toBe(false);
    expect(r.frontmatterExtra).toEqual({
      dossier: { id: "d1", updated_at: "2026-09-22T00:00:00.000Z", item_count: 1, synced_at: "2026-09-22" },
    });
    expect(r.parts.quotes).toHaveLength(1);
    expect(r.parts.quotes[0].excerpts).toHaveLength(2);
  });

  it("CRLF の抜粋も行ごとに > を付ける", () => {
    const r = renderQuoteBlogArticle(input([blog(["一行目\r\n二行目"])]));
    expect(r.body).toContain("> 一行目\n> 二行目");
    expect(r.body).not.toContain("\r");
  });

  it("ブログ画像やトークが一緒に入っていても本文には出さない", () => {
    const r = renderQuoteBlogArticle(
      input([
        blog(["名言"]),
        asset({ id: "img", kind: "image", title: "坂井新奈ブログ「だいすき！」 (1/3)", source: { kind: "url", title: "坂井新奈ブログ「だいすき！」", url: BLOG_URL, publishedAt: "2025-11-27" } }),
        asset({ id: "talk", kind: "image", title: "坂井新奈トーク 2025.11.27 20:00", source: { kind: "other", title: "Talk", url: null, publishedAt: null } }),
      ])
    );
    expect(r.body).not.toContain("関連メディア");
    expect(r.sources).toHaveLength(1);
  });

  it("本人ブログの抜粋が無ければ入力エラー (ひなたぼっこ日記の抜粋は数えない)", () => {
    expect(() => renderQuoteBlogArticle(input([]))).toThrow(TemplateInputError);
    expect(() => renderQuoteBlogArticle(input([blog([])]))).toThrow(/抜粋がドシエにありません/);
    const staff = asset({
      id: "staff",
      title: "ひなたぼっこ日記「集合」",
      source: { kind: "url", title: "集合", url: STAFF_URL, publishedAt: "2025-11-27" },
      excerpts: ["運営の言葉"],
    });
    expect(() => renderQuoteBlogArticle(input([staff]))).toThrow(TemplateInputError);
  });

  it("抜粋のあるブログが 2 本あれば入力エラー (1 ブログ 1 記事)", () => {
    const other = blog(["別の名言"], {
      id: "blog-2",
      title: "坂井新奈ブログ「白い彗星 坂井新奈」",
      source: { kind: "url", title: "坂井新奈ブログ「白い彗星 坂井新奈」", url: BLOG_URL.replace("66852", "59987"), publishedAt: "2025-05-10" },
    });
    expect(() => renderQuoteBlogArticle(input([blog(["名言"]), other]))).toThrow(/2 本あります/);
  });
});

describe("quote_blog の追記", () => {
  it("増えた抜粋を見出しも出典行も付けずに末尾へ足し、出典は既存の 1 番を使う", () => {
    const r = renderQuoteBlogArticle(input([blog(["古い名言", "新しい名言"])]));
    const existing = "坂井新奈ブログでの名言を紹介する。\n\n> 古い名言\n";
    const p = planAppend({
      existingBody: existing,
      parts: r.parts,
      sources: r.sources,
      existingSources: [{ sourceNo: 1, assetId: "blog-text", url: BLOG_URL }],
      layout: QUOTE_BLOG_TEMPLATE.appendLayout,
    });
    expect(p.empty).toBe(false);
    expect(p.newSources).toHaveLength(0);
    expect(p.body).toBe("坂井新奈ブログでの名言を紹介する。\n\n> 古い名言\n\n> 新しい名言\n\n");
    expect(p.body).not.toContain("##");
    expect(p.body).not.toContain("*引用:");
    expect(p.additions.map((a) => a.kind)).toEqual(["quote"]);
  });

  it("既にある抜粋は足さない", () => {
    const r = renderQuoteBlogArticle(input([blog(["古い名言"])]));
    const p = planAppend({
      existingBody: "坂井新奈ブログでの名言を紹介する。\n\n> 古い名言\n",
      parts: r.parts,
      sources: r.sources,
      existingSources: [{ sourceNo: 1, assetId: "blog-text", url: BLOG_URL }],
      layout: QUOTE_BLOG_TEMPLATE.appendLayout,
    });
    expect(p.empty).toBe(true);
  });
});
