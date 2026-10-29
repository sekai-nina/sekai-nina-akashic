import { describe, expect, it } from "vitest";

import { isPureAppend, planAppend } from "@/lib/meetgreet/append";
import type { ArticleAssetInput } from "../render";
import { OUTING_BODY_PLACEHOLDER, OUTING_TEMPLATE, outingLocations, outingPrompt, renderOutingArticle } from "./outing";
import type { AiDraft, DossierPlace, DossierRenderInput } from "./types";

const BLOG_URL = "https://www.hinatazaka46.com/s/official/diary/detail/65510";

const asset = (over: Partial<ArticleAssetInput> & { id: string }): ArticleAssetInput => ({
  kind: "image",
  title: over.id,
  canonicalDate: "2025-08-18",
  sortAt: "2025-08-18T10:00:00.000Z",
  source: null,
  excerpts: [],
  ...over,
});

const blog = asset({
  id: "blog",
  kind: "text",
  title: "蔵盛妃那乃ブログ「布団の中で眠りに就く頃には『蔵盛妃那乃』」",
  source: { kind: "url", title: "布団の中で眠りに就く頃には", url: BLOG_URL, publishedAt: "2025-08-18" },
  text: "江ノ島でデートをしました。海鮮丼を食べました。",
  people: ["蔵盛妃那乃", "坂井新奈"],
});
const blogImage = asset({
  id: "img-1",
  title: "蔵盛妃那乃ブログ「布団の中で眠りに就く頃には『蔵盛妃那乃』」 (1/2)",
  source: { kind: "url", title: "布団の中で眠りに就く頃には", url: BLOG_URL, publishedAt: "2025-08-18" },
});
const talk = asset({
  id: "talk-1",
  title: "坂井新奈トーク 2025.8.18 20:31",
  canonicalDate: "2025-08-18",
  sortAt: "2025-08-18T11:31:00.000Z",
  source: { kind: "other", title: "Talk", url: null, publishedAt: null },
  caption: "江ノ島の海",
});

const places: DossierPlace[] = [
  { name: "べたなぎ", placeId: "place-1", lat: 35.3, lng: 139.48, address: "神奈川県藤沢市", googleMapsUrl: "https://maps.app.goo.gl/x", note: "" },
  { name: "江ノ島金魚", placeId: null, lat: 35.31, lng: 139.49, address: null, googleMapsUrl: "https://maps.app.goo.gl/y", note: "未昇格" },
  { name: "名前だけ", placeId: null, lat: null, lng: null, address: null, googleMapsUrl: null, note: "" },
];

const input = (assets: ArticleAssetInput[], p: DossierPlace[] = places): DossierRenderInput => ({
  dossier: { id: "d1", title: "蔵盛妃那乃と江ノ島デート", updatedAt: "2026-09-22T00:00:00.000Z", itemCount: assets.length },
  assets,
  reports: [],
  tiktoks: [],
  thumbnailUrl: null,
  places: p,
  today: "2026-09-22",
});

const draft: AiDraft = {
  body: "2025年8月頃、坂井新奈と蔵盛妃那乃は江ノ島にてデートをした^[1]。\n\n## 海鮮丼\n\n- 海鮮丼を食べた^[1]\n\t- [べたなぎ](https://maps.app.goo.gl/x)という店である\n- 出典の無い番号^[5]",
  tags: ["蔵盛妃那乃", "レジャー"],
  title: null,
  date: "2025-08-01",
  dateDisplay: "2025年8月頃",
};

describe("outingLocations", () => {
  it("昇格済みは place_id だけ、未昇格は座標 + Google マップ、座標の無い候補は落とす", () => {
    expect(outingLocations(places)).toEqual([
      { name: "べたなぎ", place_id: "place-1" },
      { name: "江ノ島金魚", lat: 35.31, lng: 139.49, google_maps_url: "https://maps.app.goo.gl/y" },
    ]);
  });
});

describe("renderOutingArticle", () => {
  it("AI の本文 + 機械の関連メディア (flat)、locations、date は下書きから", () => {
    const r = renderOutingArticle(input([talk, blogImage, blog]), draft);
    expect(r.title).toBe("蔵盛妃那乃と江ノ島デート");
    expect(r.body).toBe(
      [
        "2025年8月頃、坂井新奈と蔵盛妃那乃は江ノ島にてデートをした^[1]。",
        "",
        "## 海鮮丼",
        "",
        "- 海鮮丼を食べた^[1]",
        "\t- [べたなぎ](https://maps.app.goo.gl/x)という店である",
        "- 出典の無い番号",
        "",
        "## 関連メディア",
        "",
        "- 【トーク・画像】坂井新奈トーク 2025.8.18 20:31^[2]",
        "- 【ブログ・画像】蔵盛妃那乃ブログ「布団の中で眠りに就く頃には『蔵盛妃那乃』」 (1/2)^[1]",
        "",
      ].join("\n")
    );
    expect(r.sources.map((s) => [s.sourceNo, s.assetId])).toEqual([
      [1, "blog"],
      [2, "talk-1"],
    ]);
    expect(r.tags).toEqual(["蔵盛妃那乃", "レジャー"]);
    expect(r.dates).toEqual({ date: "2025-08-01", dateDisplay: "2025年8月頃", dateMode: null });
    expect(r.draft).toBe(true);
    expect(r.frontmatterExtra).toEqual({
      dossier: { id: "d1", updated_at: "2026-09-22T00:00:00.000Z", item_count: 3, synced_at: "2026-09-22" },
      locations: [
        { name: "べたなぎ", place_id: "place-1" },
        { name: "江ノ島金魚", lat: 35.31, lng: 139.49, google_maps_url: "https://maps.app.goo.gl/y" },
      ],
    });
    // 追記の内訳: 関連メディアだけ
    expect(r.parts.quotes).toEqual([]);
    expect(r.parts.talks).toHaveLength(1);
    expect(r.parts.blogImages).toHaveLength(1);
  });

  it("AI が書いてしまった `## 関連メディア` は落として機械の章に置き換える", () => {
    const r = renderOutingArticle(input([talk, blog]), { ...draft, body: "冒頭^[1]。\n\n## 関連メディア\n\n- 勝手に書いた" });
    expect(r.body).toBe(
      "冒頭^[1]。\n\n## 関連メディア\n\n- 【トーク・画像】坂井新奈トーク 2025.8.18 20:31^[2]\n"
    );
  });

  it("文章のトークは出典にはなるが関連メディアには載せない", () => {
    const textTalk = asset({
      id: "talk-text",
      kind: "text",
      title: "坂井新奈トーク 2025.8.18 21:00",
      sortAt: "2025-08-18T12:00:00.000Z",
      source: { kind: "other", title: "Talk", url: null, publishedAt: null },
      text: "楽しかった",
    });
    const r = renderOutingArticle(input([talk, textTalk, blog]), draft);
    expect(r.sources.map((s) => s.assetId)).toEqual(["blog", "talk-1", "talk-text"]);
    expect(r.body).toContain("- 【トーク・画像】坂井新奈トーク 2025.8.18 20:31^[2]");
    expect(r.body).not.toContain("21:00");
    expect(r.parts.talks.map((t) => t.assetId)).toEqual(["talk-1"]);
  });

  it("下書きが無ければプレースホルダ + 関連メディア。場所候補が無ければ locations を出さない", () => {
    const r = renderOutingArticle(input([talk], []), null);
    expect(r.body.startsWith(`${OUTING_BODY_PLACEHOLDER}\n\n## 関連メディア`)).toBe(true);
    expect(r.frontmatterExtra).toEqual({
      dossier: { id: "d1", updated_at: "2026-09-22T00:00:00.000Z", item_count: 1, synced_at: "2026-09-22" },
    });
    expect(r.dates.date).toBeNull();
  });

  it("非公開の聖地も linkedPlaceIds から placeIds に入り、locations・AI には出ない (#283)", () => {
    // 非公開の聖地 (place-secret) は places に入らず、ID だけ linkedPlaceIds で来る
    const r = renderOutingArticle({ ...input([talk]), linkedPlaceIds: ["place-1", "place-secret"] }, draft);
    expect(r.placeIds).toEqual(["place-1", "place-secret"]);
    expect(JSON.stringify(r.frontmatterExtra)).not.toContain("place-secret");
    const p = outingPrompt({ ...input([blog, talk]), linkedPlaceIds: ["place-1", "place-secret"] }, {
      existingTitles: [],
      tagVocabulary: [],
    });
    expect(p.user).not.toContain("place-secret");
  });

  it("linkedPlaceIds が無ければ昇格済みの場所候補から placeIds を作る", () => {
    expect(renderOutingArticle(input([talk]), draft).placeIds).toEqual(["place-1"]);
  });

  it("プロンプトに場所候補と素材が入り、system は 2 ブロック", () => {
    const p = outingPrompt(input([blog, talk]), { existingTitles: ["ひとりパフェ"], tagVocabulary: ["飲食店", "レジャー"] });
    expect(p.system).toHaveLength(2);
    expect(p.system[0]).toContain("引用はしない");
    expect(p.system[0]).toContain("編集の鉄則");
    expect(p.user).toContain("## 場所候補");
    expect(p.user).toContain("- べたなぎ / 神奈川県藤沢市 / https://maps.app.goo.gl/x");
    expect(p.user).toContain("- 江ノ島金魚 / https://maps.app.goo.gl/y");
    // 編集メモは AI に渡さない
    expect(p.user).not.toContain("未昇格");
    expect(p.user).toContain("### ^[1] 蔵盛妃那乃ブログ");
    expect(p.included).toBe(2);
  });

  it("画面で直したルール文があれば system の前半を差し替え、語彙のブロックはそのまま", () => {
    const base = { existingTitles: ["ひとりパフェ"], tagVocabulary: ["飲食店"] };
    const p = outingPrompt(input([blog]), { ...base, rules: "直したルール" });
    expect(p.system[0]).toBe("直したルール");
    expect(p.system[1]).toBe(outingPrompt(input([blog]), base).system[1]);
    // 空白だけなら既定
    expect(outingPrompt(input([blog]), { ...base, rules: "  \n" }).system[0]).toBe(OUTING_TEMPLATE.defaultRules);
  });
});

describe("outing の追記 (関連メディアは flat)", () => {
  it("新しいトークを `## 関連メディア` の箇条書きに小見出し無しで足す", () => {
    const r = renderOutingArticle(input([talk, blogImage, blog]), draft);
    const existing = r.body.replace("- 【トーク・画像】坂井新奈トーク 2025.8.18 20:31^[2]\n", "");
    const p = planAppend({
      existingBody: existing,
      parts: r.parts,
      sources: r.sources,
      existingSources: [{ sourceNo: 1, assetId: "blog", url: BLOG_URL }],
      layout: OUTING_TEMPLATE.appendLayout,
    });
    expect(p.empty).toBe(false);
    expect(p.newSources.map((s) => s.sourceNo)).toEqual([2]);
    expect(p.body).not.toContain("### トーク");
    // トークはブログ画像の前 (フル生成と同じ並び)
    expect(p.body).toContain("- 【トーク・画像】坂井新奈トーク 2025.8.18 20:31^[2]\n- 【ブログ・画像】蔵盛妃那乃ブログ「布団の中で眠りに就く頃には『蔵盛妃那乃』」 (1/2)^[1]\n");
  });

  it("関連メディアの章が無い記事には章ごと足す (導入文は書かない)", () => {
    const r = renderOutingArticle(input([talk, blog]), draft);
    const p = planAppend({
      existingBody: "本文だけ。\n",
      parts: r.parts,
      sources: r.sources,
      existingSources: [{ sourceNo: 1, assetId: "blog", url: BLOG_URL }],
      layout: OUTING_TEMPLATE.appendLayout,
    });
    expect(p.body).toBe("本文だけ。\n\n## 関連メディア\n\n- 【トーク・画像】坂井新奈トーク 2025.8.18 20:31^[2]\n");
  });

  it("坂井新奈が出ているものがあれば、新しい章を小見出しで分ける", () => {
    const r = renderOutingArticle(input([{ ...talk, ninaAppears: true }, blog]), draft);
    const p = planAppend({
      existingBody: "本文だけ。\n",
      parts: { ...r.parts, blogImages: [{ assetId: "img", line: "- 【ブログ・画像】別の写真^[1]" }] },
      sources: r.sources,
      existingSources: [{ sourceNo: 1, assetId: "blog", url: BLOG_URL }],
      layout: OUTING_TEMPLATE.appendLayout,
    });
    expect(p.body).toBe(
      "本文だけ。\n\n## 関連メディア\n\n### 坂井新奈が写っているもの\n\n- 【トーク・画像】坂井新奈トーク 2025.8.18 20:31^[2]\n\n### そのほか\n\n- 【ブログ・画像】別の写真^[1]\n"
    );
  });

  it("小見出しの無い既存の章に出ているものを足すときは、末尾に小見出しを作る (既存の行は動かさない)", () => {
    const existing = "本文。\n\n## 関連メディア\n\n- 【ブログ・画像】前からある^[1]\n";
    const p = planAppend({
      existingBody: existing,
      parts: {
        quotes: [],
        reports: [],
        tiktoks: [],
        talks: [],
        blogImages: [
          { assetId: "a", line: "- 【ブログ・画像】写っている^[1]", ninaAppears: true },
          { assetId: "b", line: "- 【ブログ・画像】写っていない^[1]" },
        ],
      },
      sources: [],
      existingSources: [{ sourceNo: 1, assetId: "blog", url: BLOG_URL }],
      layout: OUTING_TEMPLATE.appendLayout,
    });
    expect(p.body).toBe(
      existing +
        "\n### 坂井新奈が写っているもの\n\n- 【ブログ・画像】写っている^[1]\n\n### そのほか\n\n- 【ブログ・画像】写っていない^[1]\n"
    );
    expect(isPureAppend(existing, p.body)).toBe(true);
  });
});

describe("renderOutingArticle (坂井新奈が出ているもの)", () => {
  it("出ているものがあれば関連メディアを 2 つの小見出しに分け、導入文は書かない", () => {
    const r = renderOutingArticle(input([{ ...talk, ninaAppears: true }, blogImage, blog]), draft);
    expect(r.body).toContain(
      [
        "## 関連メディア",
        "",
        "### 坂井新奈が写っているもの",
        "",
        "- 【トーク・画像】坂井新奈トーク 2025.8.18 20:31^[2]",
        "",
        "### そのほか",
        "",
        "- 【ブログ・画像】蔵盛妃那乃ブログ「布団の中で眠りに就く頃には『蔵盛妃那乃』」 (1/2)^[1]",
        "",
      ].join("\n")
    );
    expect(r.body).not.toContain("このおでかけに関する記録");
  });
});
