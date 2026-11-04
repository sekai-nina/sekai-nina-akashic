import { describe, expect, it } from "vitest";

import { isPureAppend, planAppend } from "@/lib/meetgreet/append";
import type { ArticleAssetInput } from "../render";
import { getTemplate, selectableTemplates } from "./index";
import { ITEM_BODY_PLACEHOLDER, ITEM_TEMPLATE, itemPrompt, renderItemArticle } from "./item";
import type { AiDraft, DossierRenderInput } from "./types";

const BLOG_URL = "https://www.hinatazaka46.com/s/official/diary/detail/60934";

const asset = (over: Partial<ArticleAssetInput> & { id: string }): ArticleAssetInput => ({
  kind: "image",
  title: over.id,
  canonicalDate: "2025-06-29",
  sortAt: "2025-06-29T10:00:00.000Z",
  source: null,
  excerpts: [],
  ...over,
});

const blog = asset({
  id: "blog",
  kind: "text",
  title: "坂井新奈ブログ「氷の溶ける音坂井新奈」",
  source: { kind: "url", title: "氷の溶ける音", url: BLOG_URL, publishedAt: "2025-06-29" },
  text: "富田鈴花さんからオーストラリアのお土産をいただきました。",
  people: ["坂井新奈", "富田鈴花"],
});
const blogImage = asset({
  id: "img-1",
  title: "坂井新奈ブログ「氷の溶ける音坂井新奈」 (1/2)",
  source: { kind: "url", title: "氷の溶ける音", url: BLOG_URL, publishedAt: "2025-06-29" },
});
const imageTalk = asset({
  id: "talk-image",
  title: "坂井新奈トーク 2025.6.29 20:31",
  sortAt: "2025-06-29T11:31:00.000Z",
  source: { kind: "other", title: "Talk", url: null, publishedAt: null },
});
const textTalk = asset({
  id: "talk-text",
  kind: "text",
  title: "坂井新奈トーク 2025.6.29 20:32",
  sortAt: "2025-06-29T11:32:00.000Z",
  source: { kind: "other", title: "Talk", url: null, publishedAt: null },
  text: "ぬいぐるみかわいい",
});

const input = (assets: ArticleAssetInput[], tiktoks: string[] = []): DossierRenderInput => ({
  dossier: { id: "d1", title: "赤い服を着たカンガルーのぬいぐるみ", updatedAt: "2026-11-05T00:00:00.000Z", itemCount: assets.length },
  assets,
  reports: [],
  tiktoks,
  thumbnailUrl: null,
  places: [],
  today: "2026-11-05",
});

const draft: AiDraft = {
  body: "坂井新奈が先輩からもらったぬいぐるみ。\n\n- 富田鈴花からもらった^[1]\n- 出典の無い番号^[9]",
  tags: ["富田鈴花", " ぬいぐるみ ", "富田鈴花"],
  title: null,
  date: "2025-06-29",
  dateDisplay: "2025年6月頃",
};

describe("renderItemArticle", () => {
  it("本文・date・tags を下書きから、タイトルはドシエから取り、宛先の無い脚注は落とす", () => {
    const r = renderItemArticle(input([blog]), { ...draft, title: "AI のタイトル" });
    expect(r.title).toBe("赤い服を着たカンガルーのぬいぐるみ");
    expect(r.body).toBe("坂井新奈が先輩からもらったぬいぐるみ。\n\n- 富田鈴花からもらった^[1]\n- 出典の無い番号\n");
    expect(r.tags).toEqual(["富田鈴花", "ぬいぐるみ"]);
    expect(r.dates).toEqual({ date: "2025-06-29", dateDisplay: "2025年6月頃", dateMode: null });
    expect(r.sources).toEqual([
      { sourceNo: 1, url: BLOG_URL, label: "坂井新奈ブログ「氷の溶ける音坂井新奈」", date: "2025-06-29", assetId: "blog" },
    ]);
    expect(r.draft).toBe(true);
    expect(r.frontmatterExtra).toEqual({ dossier: expect.anything() });
  });

  it("関連メディアは画像のトークとブログ画像と TikTok を載せ、文章のトークは出典にだけ使う", () => {
    const tiktok = "https://www.tiktok.com/@hinatazaka46/video/7000000000000000000";
    const r = renderItemArticle(input([blog, blogImage, imageTalk, textTalk], [tiktok]), draft);
    const media = r.body.slice(r.body.indexOf("## 関連メディア"));
    expect(r.body).toContain("## 関連メディア");
    expect(media).toContain("氷の溶ける音");
    expect(media).toContain("坂井新奈トーク 2025.6.29 20:31");
    expect(media).not.toContain("20:32");
    expect(media).toContain(tiktok);
    expect(r.sources.map((s) => s.assetId)).toContain("talk-text");
    expect(r.parts.talks.map((t) => t.assetId)).toEqual(["talk-image"]);
  });

  it("AI が書いた関連メディアの章は落とす (機械の章と二重にしない)", () => {
    const r = renderItemArticle(input([blog, imageTalk]), { ...draft, body: `${draft.body}\n\n## 関連メディア\n\n- AI の行` });
    expect(r.body).not.toContain("AI の行");
    expect(r.body.match(/## 関連メディア/g)).toHaveLength(1);
  });

  it("下書きが無い / 空 / 関連メディアだけならプレースホルダの骨組みで、出典と関連メディアは残す", () => {
    for (const d of [null, { ...draft, body: "  " }, { ...draft, body: "## 関連メディア\n\n- AI の行" }]) {
      const r = renderItemArticle(input([blog, imageTalk]), d);
      expect(r.body.startsWith(ITEM_BODY_PLACEHOLDER)).toBe(true);
      expect(r.body).toContain("## 関連メディア");
      expect(r.tags).toEqual([]);
      expect(r.dates).toEqual({ date: null, dateDisplay: null, dateMode: null });
      expect(r.sources).toHaveLength(2);
    }
  });
});

describe("itemPrompt", () => {
  it("タイトルと素材を番号つきで渡し、語彙は system に入れる", () => {
    const p = itemPrompt(input([blog]), { existingTitles: ["柔道着"], tagVocabulary: ["ぬいぐるみ"] });
    expect(p.user).toContain("記事のタイトル (= まとめる物): 赤い服を着たカンガルーのぬいぐるみ");
    expect(p.user).toContain("富田鈴花さんから");
    expect(p.included).toBe(1);
    expect(p.system[0]).toBe(ITEM_TEMPLATE.defaultRules);
    expect(p.system[1]).toContain("- 柔道着");
  });

  it("画面で直したルール文があれば既定を差し替える", () => {
    const p = itemPrompt(input([blog]), { existingTitles: [], tagVocabulary: [], rules: "直したルール" });
    expect(p.system[0]).toBe("直したルール");
  });
});

describe("登録簿", () => {
  it("企画から選べて、記事の型は item", () => {
    expect(getTemplate("item")).toBe(ITEM_TEMPLATE);
    expect(selectableTemplates().map((t) => t.key)).toContain("item");
    expect(ITEM_TEMPLATE.articleType).toBe("item");
  });
});

describe("追記", () => {
  it("新しい画像のトークは関連メディアの行として足せる", () => {
    const before = renderItemArticle(input([blog]), draft);
    const after = renderItemArticle(input([blog, imageTalk]), draft);
    const plan = planAppend({
      existingBody: before.body,
      parts: after.parts,
      sources: after.sources,
      existingSources: [{ sourceNo: 1, assetId: "blog", url: BLOG_URL }],
      layout: ITEM_TEMPLATE.appendLayout,
    });
    expect(plan.newSources.map((s) => s.assetId)).toEqual(["talk-image"]);
    expect(plan.body).toContain("坂井新奈トーク 2025.6.29 20:31");
    expect(isPureAppend(before.body, plan.body)).toBe(true);
  });
});
