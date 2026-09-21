import { describe, expect, it } from "vitest";

import { buildMaterialsText, MAX_CHARS_PER_SOURCE } from "../materials";
import type { ArticleAssetInput } from "../render";
import { ATTRIBUTE_BODY_PLACEHOLDER, attributePrompt, attributeSystemPrompt, renderAttributeArticle } from "./attribute";
import type { AiDraft, DossierRenderInput } from "./types";

const BLOG_URL = "https://www.hinatazaka46.com/s/official/diary/detail/65437";

const asset = (over: Partial<ArticleAssetInput> & { id: string }): ArticleAssetInput => ({
  kind: "image",
  title: over.id,
  canonicalDate: "2025-11-14",
  sortAt: "2025-11-14T11:31:00.000Z",
  source: null,
  excerpts: [],
  ...over,
});

const blog = asset({
  id: "blog",
  kind: "text",
  title: "坂井新奈ブログ「しゃぼん🫧 坂井新奈」",
  canonicalDate: "2025-08-18",
  sortAt: "2025-08-18T10:00:00.000Z",
  source: { kind: "url", title: "坂井新奈ブログ「しゃぼん🫧 坂井新奈」", url: BLOG_URL, publishedAt: "2025-08-18" },
  excerpts: ["家に帰ろうとすると違うところへ行ってしまう"],
  text: "こんにちは。\r\n家に帰ろうとすると違うところへ行ってしまうことがあります。\r\n",
  people: ["坂井新奈"],
});
const talk = asset({
  id: "talk-1",
  title: "坂井新奈トーク 2025.11.14 20:31",
  source: { kind: "other", title: "Talk", url: null, publishedAt: null },
  text: "すごく静かに道を間違えるってりかちゃんに言われた",
  caption: "方向音痴の話",
  people: ["坂井新奈", "鶴崎仁香"],
});

const input = (assets: ArticleAssetInput[]): DossierRenderInput => ({
  dossier: { id: "d1", title: "方向音痴", updatedAt: "2026-09-22T00:00:00.000Z", itemCount: assets.length },
  assets,
  reports: [],
  tiktoks: [],
  thumbnailUrl: null,
  today: "2026-09-22",
});

const draft: AiDraft = {
  body: "坂井新奈はかなりの方向音痴である。\r\n\r\n- 家に帰ろうとすると違うところへ行ってしまうことがある^[1]  \r\n- 鶴崎仁香によると「すごく静かに道を間違える」らしい^[2]",
  tags: ["鶴崎仁香", " 鶴崎仁香", ""],
  title: null,
  date: null,
  dateDisplay: null,
};

describe("buildMaterialsText", () => {
  it("出典番号を render と同じ採番 (ブログ → トーク) で付け、本文・抜粋・人物・キャプションを載せる", () => {
    const m = buildMaterialsText(input([talk, blog]));
    expect(m.included).toBe(2);
    expect(m.truncated).toBe(0);
    const blogAt = m.text.indexOf("### ^[1] 坂井新奈ブログ「しゃぼん🫧 坂井新奈」（2025-08-18）");
    const talkAt = m.text.indexOf("### ^[2] 坂井新奈トーク 2025.11.14 20:31（2025-11-14）");
    expect(blogAt).toBeGreaterThanOrEqual(0);
    expect(talkAt).toBeGreaterThan(blogAt);
    expect(m.text).toContain("> 家に帰ろうとすると違うところへ行ってしまう");
    expect(m.text).toContain("登場人物: 坂井新奈、鶴崎仁香");
    expect(m.text).toContain("- 方向音痴の話");
    // CRLF は落とす
    expect(m.text).not.toContain("\r");
  });

  it("長い本文は出典ごとの上限で切って件数を返す", () => {
    const long = asset({ ...blog, id: "long", text: "あ".repeat(MAX_CHARS_PER_SOURCE + 500) });
    const m = buildMaterialsText(input([long]));
    expect(m.truncated).toBe(1);
    expect(m.text).toContain("500 字を省略");
  });

  it("本文の無い画像だけのブログもそう書く。キャプションがあれば素材として数える", () => {
    const img = asset({
      id: "img",
      title: "坂井新奈ブログ「しゃぼん🫧 坂井新奈」 (1/3)",
      source: { kind: "url", title: "坂井新奈ブログ「しゃぼん🫧 坂井新奈」", url: BLOG_URL, publishedAt: "2025-08-18" },
      caption: "江ノ島の写真",
    });
    const m = buildMaterialsText(input([img]));
    expect(m.text).toContain("(本文なし。画像だけのブログ)");
    expect(m.text).toContain("- 江ノ島の写真");
    expect(m.included).toBe(1);
    // 本文・抜粋・キャプションのどれも無ければ数えない (AI に読ませるものが無い)
    expect(buildMaterialsText(input([asset({ ...img, id: "img2", caption: undefined })])).included).toBe(0);
  });

  it("全体の上限に達しても、後ろの出典に最低限の本文は残す", () => {
    const blogs = Array.from({ length: 8 }, (_, i) =>
      asset({
        id: `b${i}`,
        kind: "text",
        title: `坂井新奈ブログ「${i}」`,
        canonicalDate: `2025-01-0${i + 1}`,
        source: { kind: "url", title: `坂井新奈ブログ「${i}」`, url: `${BLOG_URL}${i}`, publishedAt: `2025-01-0${i + 1}` },
        text: "あ".repeat(MAX_CHARS_PER_SOURCE),
      })
    );
    const m = buildMaterialsText(input([...blogs, talk]));
    expect(m.included).toBe(9);
    // 最後のトークの本文は丸ごと残る (短いので最低枠に収まる)
    expect(m.text).toContain("すごく静かに道を間違えるってりかちゃんに言われた");
  });
});

describe("attributePrompt", () => {
  it("system は鉄則・見本・語彙の順で毎回同じ、user に素材とタイトルが入る", () => {
    const ctx = { existingTitles: ["高井俐香と3時間半迷子になった", "方向音痴"], tagVocabulary: ["幼少期", "家族"] };
    const p1 = attributePrompt(input([blog]), ctx);
    const p2 = attributePrompt(input([blog, talk]), ctx);
    expect(p1.system).toEqual(p2.system);
    expect(p1.system).toEqual(attributeSystemPrompt(ctx));
    // 鉄則・見本 と 語彙 は別ブロック (語彙が変わっても前半のキャッシュが残る)
    expect(p1.system).toHaveLength(2);
    expect(p1.system[0]).toContain("坂井新奈以外のメンバーの感想・気持ちは書かない");
    expect(p1.system[0]).not.toContain("## 既存のタグ");
    expect(p1.system[1]).toContain("- 高井俐香と3時間半迷子になった");
    expect(p1.system[1]).toContain("幼少期、家族");
    expect(p1.user).toContain("記事のタイトル (= まとめる属性): 方向音痴");
    expect(p1.user).toContain("### ^[1] 坂井新奈ブログ");
    expect(p1.included).toBe(1);
    expect(p2.included).toBe(2);
  });
});

describe("renderAttributeArticle", () => {
  it("出典に無い番号の ^[n] は落とす (宛先の無い脚注を出さない)", () => {
    const r = renderAttributeArticle(input([talk, blog]), { ...draft, body: "- 事実^[2]\n- 作った番号^[9]\n- ゼロ^[0]" });
    expect(r.body).toBe("- 事実^[2]\n- 作った番号\n- ゼロ\n");
  });

  it("空の本文は下書き無しと同じ (骨組み)", () => {
    const r = renderAttributeArticle(input([talk, blog]), { ...draft, body: "  \n" });
    expect(r.body).toBe(`${ATTRIBUTE_BODY_PLACEHOLDER}\n`);
    expect(r.tags).toEqual([]);
  });

  it("下書きを差し込み、出典を採番し、draft: true・date 無しで返す", () => {
    const r = renderAttributeArticle(input([talk, blog]), draft);
    expect(r.title).toBe("方向音痴");
    expect(r.body).toBe(
      "坂井新奈はかなりの方向音痴である。\n\n- 家に帰ろうとすると違うところへ行ってしまうことがある^[1]\n- 鶴崎仁香によると「すごく静かに道を間違える」らしい^[2]\n"
    );
    expect(r.tags).toEqual(["鶴崎仁香"]);
    expect(r.sources.map((s) => [s.sourceNo, s.assetId, s.url])).toEqual([
      [1, "blog", BLOG_URL],
      [2, "talk-1", null],
    ]);
    expect(r.dates).toEqual({ date: null, dateDisplay: null, dateMode: null });
    expect(r.draft).toBe(true);
    expect(r.frontmatterExtra).toEqual({
      dossier: { id: "d1", updated_at: "2026-09-22T00:00:00.000Z", item_count: 2, synced_at: "2026-09-22" },
    });
    expect(r.parts.quotes).toEqual([]);
  });

  it("下書きが無い (AI が使えない) ときはプレースホルダだけの本文で、出典は同じ", () => {
    const r = renderAttributeArticle(input([talk, blog]), null);
    expect(r.body).toBe(`${ATTRIBUTE_BODY_PLACEHOLDER}\n`);
    expect(r.tags).toEqual([]);
    expect(r.sources).toHaveLength(2);
    expect(r.draft).toBe(true);
  });
});
