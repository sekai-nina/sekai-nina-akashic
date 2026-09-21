/**
 * 言葉記事 (本人ブログの名言) のテンプレート (#170)。
 *
 * `sekai-nina-site/.claude/skills/dossier-to-quote-article/quote_brief.py` の blog モードの移植。
 * 本文はリード 1 文 + ドシエの抜粋を引用ブロックで並べるだけで、AI は要らない。
 * 出典は本人ブログ 1 件。既存の 40 本 (`quote/ブログ「…」.md`) と同じ形にする:
 *
 * - タイトル `坂井新奈ブログ「X」` → `ブログ「X」`
 * - `date` / `date_display` は持たない (既存記事に無い)
 * - `{q}…{/q}` (featured 名言のハイライト) は付けない。あれは人が後から選ぶ
 * - 関連メディアの章は出さない (ブログ画像があっても言葉記事には載せない)
 */

import { TemplateInputError } from "../errors";
import {
  blockquote,
  blogLabel,
  classifyMaterials,
  dossierSnapshot,
  emptyParts,
  joinBody,
  type RenderedArticle,
} from "../render";
import type { ArticleTemplateDef, DossierRenderInput } from "./types";

export const QUOTE_BLOG_LEAD = "坂井新奈ブログでの名言を紹介する。";

/** `坂井新奈ブログ「包まれて」` → `ブログ「包まれて」`。パターン外はそのまま */
export function quoteBlogTitle(assetTitle: string): string {
  const m = assetTitle.match(/^.+?ブログ(「.*」)\s*$/);
  return m ? `ブログ${m[1]}` : assetTitle || "無題";
}

export function renderQuoteBlogArticle(input: DossierRenderInput): RenderedArticle {
  const { blogs } = classifyMaterials(input.assets);
  // ひなたぼっこ日記の抜粋は本人の言葉ではない
  const quoted = blogs.filter((b) => b.excerpts.length > 0 && !b.staff);
  if (quoted.length === 0) {
    throw new TemplateInputError(
      "本人ブログの抜粋がドシエにありません。ブログ本文を範囲選択して抜粋を入れてください"
    );
  }
  if (quoted.length > 1) {
    throw new TemplateInputError(
      `抜粋のあるブログが ${quoted.length} 本あります。言葉記事は 1 本のブログにつき 1 記事なので、ドシエを分けてください`
    );
  }
  const blog = quoted[0];
  blog.sourceNo = 1;
  const label = blogLabel(blog);

  const body: string[] = [QUOTE_BLOG_LEAD, ""];
  for (const ex of blog.excerpts) body.push(blockquote(ex), "");

  return {
    title: quoteBlogTitle(blog.title),
    tags: [],
    body: joinBody(body),
    sources: [{ sourceNo: 1, url: blog.url, label, date: blog.date || null, assetId: blog.ref }],
    parts: {
      ...emptyParts(),
      quotes: [
        {
          sourceNo: 1,
          label,
          url: blog.url,
          date: blog.date,
          excerpts: blog.excerpts.map((ex) => ex.replace(/\r\n?/g, "\n")),
        },
      ],
    },
    dates: { date: null, dateDisplay: null, dateMode: null },
    draft: false,
    frontmatterExtra: { dossier: dossierSnapshot(input.dossier, input.today) },
  };
}

export const QUOTE_BLOG_TEMPLATE: ArticleTemplateDef = {
  key: "quote_blog",
  articleType: "quote",
  needsAi: false,
  appendLayout: {
    // 引用そのものが本文。見出しも出典行も付けず、地の文の末尾に足す
    quotesHeading: null,
    quoteAttribution: false,
    // レポは載せないが、万一 external_link に X があっても章の名前は要る
    reports: { heading: "## ファンの反応", lead: "ファンの投稿（X）。" },
  },
  render: renderQuoteBlogArticle,
};
