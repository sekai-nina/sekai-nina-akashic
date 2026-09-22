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
import { NO_QUOTES_APPEND_LAYOUT } from "./shared";
import {
  blockquote,
  buildParts,
  classifyMaterials,
  dossierSnapshot,
  joinBody,
  numberSources,
  quotedBlogs,
  type RenderedArticle,
} from "../render";
import type { ArticleTemplateDef, DossierRenderInput } from "./types";

export const QUOTE_BLOG_LEAD = "坂井新奈ブログでの名言を紹介する。";

/** `坂井新奈ブログ「包まれて」` → `ブログ「包まれて」`。パターン外はそのまま */
export function quoteBlogTitle(assetTitle: string): string {
  const m = assetTitle.match(/^.+?ブログ(「.*」)\s*$/);
  return m ? `ブログ${m[1]}` : assetTitle || "無題";
}

/** このテンプレートが作る記事のタイトルか (紐づく記事からテンプレートを推すのに使う) */
export function isQuoteBlogTitle(articleTitle: string): boolean {
  return articleTitle.startsWith("ブログ「");
}

export function renderQuoteBlogArticle(input: DossierRenderInput): RenderedArticle {
  const { blogs } = classifyMaterials(input.assets);
  // ひなたぼっこ日記の抜粋は本人の言葉ではない (quotedBlogs が落とす)
  const quoted = quotedBlogs(blogs);
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
  // 出典はこのブログ 1 件 (トークやブログ画像が一緒に入っていても載せない)
  const { sources, talkSourceNo } = numberSources([blog], []);

  const body: string[] = [QUOTE_BLOG_LEAD, ""];
  for (const ex of blog.excerpts) body.push(blockquote(ex), "");

  return {
    title: quoteBlogTitle(blog.title),
    tags: [],
    body: joinBody(body),
    sources,
    parts: buildParts({ quoted, reports: [], tiktoks: [], talks: [], blogs: [], talkSourceNo }),
    dates: { date: null, dateDisplay: null, dateMode: null },
    draft: false,
    frontmatterExtra: { dossier: dossierSnapshot(input.dossier, input.today) },
  };
}

export const QUOTE_BLOG_TEMPLATE: ArticleTemplateDef = {
  key: "quote_blog",
  articleType: "quote",
  needsAi: false,
  // 引用そのものが本文。見出しも出典行も付けず、地の文の末尾に足す
  appendLayout: NO_QUOTES_APPEND_LAYOUT,
  render: renderQuoteBlogArticle,
};
