/**
 * 記事テンプレートの登録簿 (#169 / #170)。
 *
 * `ArticleTemplate` (Prisma enum) の値ごとに定義を引く。**まだ実装していないテンプレートは
 * 登録しない** (`getTemplate` が null を返し、domain 層が「まだ使えません」にする)。
 * この登録簿が実装状況の正。
 */

import type { ArticleTemplate } from "@prisma/client";
import { MEETGREET_APPEND_LAYOUT } from "@/lib/meetgreet/append";
import { ATTRIBUTE_TEMPLATE } from "./attribute";
import { OUTING_TEMPLATE } from "./outing";
import { QUOTE_BLOG_TEMPLATE } from "./quote-blog";
import { QUOTE_SITUATIONAL_TEMPLATE } from "./quote-situational";
import type { ArticleTemplateDef } from "./types";

export type {
  AiContext,
  AiDraft,
  AiPrompt,
  AiUsage,
  ArticleAiStatus,
  ArticleTemplateDef,
  DossierPlace,
  DossierRenderInput,
} from "./types";
export { AiDraftSchema, clampAiDraft } from "./types";

/** ミーグリ。組み立ては器側 (`buildMeetGreetArticle`) が開催日などと合わせて行う */
export const MEETGREET_TEMPLATE: ArticleTemplateDef = {
  key: "meetgreet",
  articleType: "event",
  needsAi: false,
  appendLayout: MEETGREET_APPEND_LAYOUT,
  render: null,
};

const TEMPLATES: Partial<Record<ArticleTemplate, ArticleTemplateDef>> = {
  meetgreet: MEETGREET_TEMPLATE,
  quote_blog: QUOTE_BLOG_TEMPLATE,
  quote_situational: QUOTE_SITUATIONAL_TEMPLATE,
  attribute: ATTRIBUTE_TEMPLATE,
  outing: OUTING_TEMPLATE,
};

export function getTemplate(key: ArticleTemplate): ArticleTemplateDef | null {
  return TEMPLATES[key] ?? null;
}

/** 器を持たないドシエが選べるテンプレート (実装済みのものだけ) */
export function selectableTemplates(): ArticleTemplateDef[] {
  return Object.values(TEMPLATES).filter((t) => t.render !== null);
}
