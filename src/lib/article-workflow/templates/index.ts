/**
 * 記事テンプレートの登録簿 (#169 / #170)。
 *
 * `ArticleTemplate` (Prisma enum) の値ごとに定義を引く。この登録簿が実装状況の正
 * (全 6 つ実装済み。器のもの = meetgreet / live は `render: null` で器側が組む)。
 */

import type { ArticleTemplate } from "@prisma/client";
import { MEETGREET_APPEND_LAYOUT } from "@/lib/meetgreet/append";
import { ATTRIBUTE_TEMPLATE } from "./attribute";
import { LIVE_TEMPLATE } from "./live";
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
export { LIVE_TEMPLATE } from "./live";

/** ミーグリ。組み立ては器側 (`buildMeetGreetArticle`) が開催日などと合わせて行う */
export const MEETGREET_TEMPLATE: ArticleTemplateDef = {
  key: "meetgreet",
  articleType: "event",
  needsAi: false,
  appendLayout: MEETGREET_APPEND_LAYOUT,
  render: null,
};

/** **この順で画面の選択肢と `selectableTemplates` に出る** (言葉の 2 つを隣に) */
const TEMPLATES: Partial<Record<ArticleTemplate, ArticleTemplateDef>> = {
  meetgreet: MEETGREET_TEMPLATE,
  live: LIVE_TEMPLATE,
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
