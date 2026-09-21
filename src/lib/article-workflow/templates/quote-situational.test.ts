import { describe, expect, it } from "vitest";

import type { ArticleAssetInput } from "../render";
import {
  QUOTE_SITUATIONAL_BODY_PLACEHOLDER,
  quoteSituationalPrompt,
  renderQuoteSituationalArticle,
} from "./quote-situational";
import { clampAiDraft, type AiDraft, type DossierRenderInput } from "./types";

const BLOG_URL = "https://www.hinatazaka46.com/s/official/diary/detail/65722";
const blog: ArticleAssetInput = {
  id: "blog",
  kind: "text",
  title: "大野愛実ブログ「日々、大野愛実」",
  canonicalDate: "2025-09-15",
  sortAt: "2025-09-15T10:00:00.000Z",
  source: { kind: "url", title: "日々、大野愛実", url: BLOG_URL, publishedAt: "2025-09-15" },
  excerpts: ["Yes, me now?"],
  text: "リハに疲れていたにぃたんに休みなと言ったら Yes, me now? と返ってきました",
  people: ["大野愛実", "坂井新奈"],
};
const input = (assets: ArticleAssetInput[]): DossierRenderInput => ({
  dossier: { id: "d1", title: "yes, me now?", updatedAt: "2026-09-22T00:00:00.000Z", itemCount: assets.length },
  assets,
  reports: [],
  tiktoks: [],
  thumbnailUrl: null,
  places: [],
  today: "2026-09-22",
});
const draft: AiDraft = {
  body: "リハーサル中のやり取りで坂井新奈が発した一言^[1]。\n\n> Yes, me now?\n\n大野愛実は「母性が溢れて涙が出そう」と綴っている^[1]。",
  tags: ["大野愛実"],
  title: "Yes, me now?",
  date: "2025-09-01",
  dateDisplay: "2025年9月頃",
};

describe("renderQuoteSituationalArticle", () => {
  it("AI のタイトルを採り、本文・date・tags を下書きから、出典は素材から", () => {
    const r = renderQuoteSituationalArticle(input([blog]), draft);
    expect(r.title).toBe("Yes, me now?");
    expect(r.body).toBe("リハーサル中のやり取りで坂井新奈が発した一言^[1]。\n\n> Yes, me now?\n\n大野愛実は「母性が溢れて涙が出そう」と綴っている^[1]。\n");
    expect(r.sources).toEqual([
      { sourceNo: 1, url: BLOG_URL, label: "大野愛実ブログ「日々、大野愛実」", date: "2025-09-15", assetId: "blog" },
    ]);
    expect(r.tags).toEqual(["大野愛実"]);
    expect(r.dates).toEqual({ date: "2025-09-01", dateDisplay: "2025年9月頃", dateMode: null });
    expect(r.draft).toBe(true);
    expect(r.body).not.toContain("関連メディア");
  });

  it("AI がタイトルを返さなければドシエのタイトル。下書きが無ければプレースホルダ", () => {
    expect(renderQuoteSituationalArticle(input([blog]), { ...draft, title: null }).title).toBe("yes, me now?");
    const r = renderQuoteSituationalArticle(input([blog]), null);
    expect(r.title).toBe("yes, me now?");
    expect(r.body).toBe(`${QUOTE_SITUATIONAL_BODY_PLACEHOLDER}\n`);
    expect(r.sources).toHaveLength(1);
  });

  it("プロンプトはドシエのタイトルを目安として渡し、見本に発言表記の整え方が入る", () => {
    const p = quoteSituationalPrompt(input([blog]), { existingTitles: [], tagVocabulary: ["大野愛実"] });
    expect(p.system).toHaveLength(2);
    expect(p.system[0]).toContain("実際の発言の表記");
    expect(p.system[0]).toContain("{q}");
    expect(p.user).toContain("ドシエのタイトル (= 言葉の目安): yes, me now?");
    expect(p.user).toContain("> Yes, me now?");
    expect(p.included).toBe(1);
  });
});

describe("clampAiDraft", () => {
  it("タイトルは NFC・制御文字除去・trim、日付は暦に実在するものだけ", () => {
    const c = clampAiDraft({ body: "b", tags: [" 大野愛実 ", ""], title: " Yes,\u0000 me now?\n ", date: "2025-13-45", dateDisplay: "  " });
    expect(c.title).toBe("Yes, me now?");
    expect(c.tags).toEqual(["大野愛実"]);
    expect(c.date).toBeNull();
    expect(c.dateDisplay).toBeNull();
    expect(clampAiDraft({ body: "b", tags: [], title: "", date: "2025-09-01", dateDisplay: "2025年9月頃" })).toEqual({
      body: "b",
      tags: [],
      title: null,
      date: "2025-09-01",
      dateDisplay: "2025年9月頃",
    });
  });
});
