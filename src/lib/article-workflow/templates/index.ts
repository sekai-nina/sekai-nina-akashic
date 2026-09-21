/**
 * 記事テンプレートの登録簿 (#169 / #170)。
 *
 * `ArticleTemplate` (Prisma enum) の値ごとに定義を引く。**まだ実装していないテンプレートは
 * 登録しない** (`getTemplate` が null を返し、domain 層が「まだ使えません」にする)。
 * 実装状況は `docs/security-dev.md` の記事の節を参照。
 */

import type { ArticleTemplate } from "@prisma/client";
import { MEETGREET_APPEND_LAYOUT } from "@/lib/meetgreet/append";
import type { ArticleTemplateDef } from "./types";

export type { ArticleTemplateDef, DossierRenderInput } from "./types";

/** ミーグリ。組み立ては器側 (`buildMeetGreetArticle`) が開催日などと合わせて行う */
const MEETGREET_TEMPLATE: ArticleTemplateDef = {
  key: "meetgreet",
  articleType: "event",
  needsAi: false,
  appendLayout: MEETGREET_APPEND_LAYOUT,
  render: null,
};

const TEMPLATES: Partial<Record<ArticleTemplate, ArticleTemplateDef>> = {
  meetgreet: MEETGREET_TEMPLATE,
};

export function getTemplate(key: ArticleTemplate): ArticleTemplateDef | null {
  return TEMPLATES[key] ?? null;
}

/** 器を持たないドシエが選べるテンプレート (実装済みのものだけ) */
export function selectableTemplates(): ArticleTemplateDef[] {
  return Object.values(TEMPLATES).filter((t) => t.render !== null);
}
