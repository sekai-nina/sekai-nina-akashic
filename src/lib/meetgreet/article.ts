/**
 * ミーグリ記事の本文組み立て (#109)。
 *
 * `sekai-nina-site/.claude/skills/dossier-to-meetgreet-article/generate.py` の移植。
 * 実戦で固まった変換ルール（出典での分類・採番順・ひなたぼっこ日記の扱い）をそのまま持ち込む。
 * **DB に触らない純粋関数**なので、既存の公開記事と突き合わせて忠実性を検証できる。
 *
 * テンプレートに依らない部分 (素材の振り分け・出典の採番・各章) は
 * `src/lib/article-workflow/render.ts` にあり (#170)、ここはミーグリ固有のタイトル・
 * イントロ・frontmatter の `meetgreet:` を足すだけ。
 *
 * 呼び出し側 (`src/lib/domain/meetgreet-article.ts`) がドシエと X レポから入力を組み立てる。
 */

import {
  buildParts,
  classifyMaterials,
  dossierSnapshot,
  joinBody,
  jpDate,
  numberSources,
  quotedBlogs,
  renderQuotesSection,
  renderRelatedMediaSection,
  renderReportsSection,
  type ArticleAssetInput,
  type RenderedArticle,
} from "@/lib/article-workflow/render";

// 以前ここにあった共通部品。import 元を変えずに済むよう再輸出する
export {
  STAFF_BLOG_NAME,
  isStaffBlog,
  jpDate,
  normalizeSourceUrl,
  normalizeTweetUrl,
  type ArticleAssetInput,
  type ArticleParts,
  type RenderedSource,
} from "@/lib/article-workflow/render";

/** ミーグリ記事の frontmatter `meetgreet:` ブロック */
export interface MeetGreetExtra extends Record<string, unknown> {
  meetgreet: { single?: string; format: string; outfit_image?: string };
}

export type RenderedMeetGreetArticle = RenderedArticle<MeetGreetExtra>;

/** ファンのレポの章の見出しと導入文。追記 (`append.ts`) も同じものを見る */
export const MEETGREET_REPORTS_LAYOUT = {
  heading: "## ファンによるミーグリレポ",
  lead: "ファンが投稿したミート＆グリートの感想（X）。",
} as const;

export interface RenderArticleInput {
  /** 開催日 (JST "YYYY-MM-DD") */
  date: string;
  format: "online" | "real";
  /** リアルのときタイトルに出す会場名 */
  venue?: string | null;
  single?: string | null;
  /** ドシエのアセット (asset_ref のアイテム由来) */
  assets: ArticleAssetInput[];
  /** ファンのレポ (X の URL)。呼び出し側が並び順と重複を解決して渡す */
  reports: string[];
  /** TikTok の URL */
  tiktoks: string[];
  /** サムネ画像の URL (スケッチ or ドシエの「サムネ」) */
  thumbnailUrl: string | null;
  /** frontmatter の dossier スナップショット用 */
  dossier: { id: string; updatedAt: string; itemCount: number };
  /** published_at / updated_at / synced_at に入れる JST の今日 */
  today: string;
}

/**
 * 記事タイトル。
 * - オンライン: `2026年8月9日 オンラインミーグリ`
 * - リアル: `2026年8月1日 リアルミーグリ（京都）` — 会場が分かるときだけ括弧を付ける
 *
 * **ファイル名 = タイトル**なので、規則を変えると URL が変わる。既存記事の改名はしない。
 */
export function articleTitleFor(input: {
  date: string;
  format: "online" | "real";
  venue?: string | null;
}): string {
  const kind = input.format === "online" ? "オンラインミーグリ" : "リアルミーグリ";
  const venue = input.venue?.trim();
  const suffix = input.format === "real" && venue ? `（${venue}）` : "";
  return `${jpDate(input.date)} ${kind}${suffix}`;
}

/** 記事の本文と出典を組み立てる */
export function renderMeetGreetArticle(input: RenderArticleInput): RenderedMeetGreetArticle {
  const online = input.format === "online";
  // 地の文・alt は略さない正式表記、タイトルは短縮形
  const kindFull = online ? "オンラインミート＆グリート" : "リアルミート＆グリート";
  const title = articleTitleFor(input);
  const titleFull = `${jpDate(input.date)} ${kindFull}`;
  const tags = online ? ["オンラインミーグリ", "ミーグリ"] : ["リアルミーグリ", "ミーグリ"];

  const { blogs, talks } = classifyMaterials(input.assets);
  const { sources, talkSourceNo } = numberSources(blogs, talks);
  const quoted = quotedBlogs(blogs);

  const body: string[] = [];

  // 1. サムネ (記事トップ)
  if (input.thumbnailUrl) {
    body.push(`<img src="${input.thumbnailUrl}" alt="${titleFull} サムネイル" width="600">`, "");
  }

  // 2. イントロ (地の文では略称を使わない)
  // 会場はタイトルにだけ出す。地の文に入れるかは記事によって割れており
  // (2026年6月13日 は入れ、2026年8月1日 は入れていない)、直近の形に合わせる
  body.push(
    `${jpDate(input.date)}、${kindFull}が開催された。坂井新奈が参加し、後日のブログやTalkでその様子を振り返っている。`,
    ""
  );

  // 3. 本人の感想 → 4. ファンのレポ → 5. 関連メディア
  body.push(...renderQuotesSection(quoted));
  body.push(...renderReportsSection(input.reports, MEETGREET_REPORTS_LAYOUT));
  body.push(...renderRelatedMediaSection({ talks, blogs, tiktoks: input.tiktoks, talkSourceNo }));

  const meetgreet: MeetGreetExtra["meetgreet"] = {
    // frontmatter は「対面」表記 (タイトルの「リアル」とは別)
    format: online ? "オンライン" : "対面",
  };
  if (input.single?.trim()) meetgreet.single = input.single.trim();
  if (input.thumbnailUrl) meetgreet.outfit_image = input.thumbnailUrl;

  return {
    title,
    tags,
    body: joinBody(body),
    sources,
    parts: buildParts({ quoted, reports: input.reports, tiktoks: input.tiktoks, talks, blogs, talkSourceNo }),
    dates: {
      date: input.date,
      // 既存のミーグリ記事はすべて date_display を持っている (generate.py も書いていた)
      dateDisplay: jpDate(input.date),
      dateMode: null,
    },
    // 既存のミーグリ記事は下書きではない
    draft: false,
    frontmatterExtra: {
      dossier: dossierSnapshot(input.dossier, input.today),
      meetgreet,
    },
  };
}
