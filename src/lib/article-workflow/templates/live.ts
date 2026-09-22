/**
 * ライブ (公演) 記事のテンプレート (#151)。
 *
 * 1 記事 = 1 ライブ (ツアー)。器は `Live` (公演 `LivePerformance`・曲 `LiveSong`・X レポの収集・スケッチ) で、
 * 組み立ては `src/lib/domain/live-article.ts` がこの純粋関数に入力を渡す。ミーグリ記事と同じ章
 * (本人の感想 / ファンのレポ / 関連メディア) に、**毎回作り直す `## 公演` の表**が足される:
 *
 * - `<!-- live:performances -->` 〜 `<!-- /live:performances -->` の間が機械の区間。追記のたびに
 *   差し替える (公演や曲を直したら記事にも反映される)。それ以外の章は「まだ無いものだけ足す」
 * - 表は `【N年目】参加したライブ・披露曲一覧` の手書きの形に合わせる (日付 / 会場 / 追加曲 / センター曲 /
 *   備考。空の列は出さない。`共通披露曲：A / B / C` を表の下に)
 * - frontmatter `live:` (サイトの `/live` ページが読む予定): name / common_songs / performances / outfit_image
 *
 * **DB に触らない純粋関数。** `live.test.ts` が形を守る。
 */

import { MEETGREET_APPEND_LAYOUT } from "@/lib/meetgreet/append";
import {
  buildParts,
  classifyMaterials,
  dossierSnapshot,
  joinBody,
  jpDate,
  numberSources,
  QUOTES_HEADING,
  quotedBlogs,
  renderQuotesSection,
  renderRelatedMediaSection,
  renderReportsSection,
  type ArticleAssetInput,
  type MarkerBlock,
  type RenderedArticle,
} from "../render";
import type { ArticleTemplateDef } from "./types";

/** 公演の表の区間。この間は機械のもので、追記のたびに差し替える */
export const LIVE_PERFORMANCES_START = "<!-- live:performances -->";
export const LIVE_PERFORMANCES_END = "<!-- /live:performances -->";
export const LIVE_PERFORMANCES_HEADING = "## 公演";

/** ファンのレポの章の見出しと導入文 (ミーグリと同型) */
export const LIVE_REPORTS_LAYOUT = {
  heading: "## ファンによるライブレポ",
  lead: "ファンが投稿したライブの感想（X）。",
} as const;

export interface LivePerformanceInput {
  /** JST "YYYY-MM-DD" */
  date: string;
  venue: string;
  /** 「昼公演」など同日の呼び分け */
  label: string;
  note: string;
  /** 公演限定の追加曲 */
  songs: string[];
  centerSongs: string[];
}

export interface LiveRenderInput {
  name: string;
  /** 補足 (「セットリスト違いの A / B パターン」等)。公演の章の頭に出す */
  note: string;
  /** 公演 (並び順)。無ければ表は出さず「公演未設定」 */
  performances: LivePerformanceInput[];
  /** ライブ共通の披露曲 */
  commonSongs: string[];
  assets: ArticleAssetInput[];
  reports: string[];
  tiktoks: string[];
  /** スケッチ (確定したもの) か、ドシエの「サムネ」 */
  thumbnailUrl: string | null;
  dossier: { id: string; updatedAt: string; itemCount: number };
  today: string;
}

/** frontmatter の `live:` ブロック */
export interface LiveExtra extends Record<string, unknown> {
  live: {
    name: string;
    common_songs: string[];
    performances: {
      date: string;
      venue: string;
      label: string;
      songs: string[];
      center_songs: string[];
      note: string;
    }[];
    outfit_image?: string;
  };
}

export type RenderedLiveArticle = RenderedArticle<LiveExtra>;

/** "2026-03-13" → "2026/3/13" (手書きの一覧と同じ) */
function slashDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${y}/${Number(m)}/${Number(d)}`;
}

/** 初日〜最終日 (日付順の最小と最大。並び順が日付順でなくてもよいように) */
export function performanceRange(performances: { date: string }[]): { first: string; last: string } | null {
  if (performances.length === 0) return null;
  const dates = performances.map((p) => p.date).sort();
  return { first: dates[0], last: dates[dates.length - 1] };
}

/** 「2025年9月20日〜11月21日」(同じ年なら後ろの年を省く)。1 日なら単日 */
export function jpDateRange(first: string, last: string): string {
  if (first === last) return jpDate(first);
  const [fy] = first.split("-");
  const [ly, lm, ld] = last.split("-");
  const tail = fy === ly ? `${Number(lm)}月${Number(ld)}日` : jpDate(last);
  return `${jpDate(first)}〜${tail}`;
}

/** Markdown の表のセル (`|` と改行を潰す) */
function cell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "／").trim();
}

/**
 * 公演の表 (マーカーの内側)。空の列 (追加曲 / センター曲 / 備考) は出さない。
 * 公演が無ければ 1 行の注記だけ
 */
export function renderPerformancesBlock(input: {
  performances: LivePerformanceInput[];
  commonSongs: string[];
}): string[] {
  const { performances, commonSongs } = input;
  if (performances.length === 0) return ["（公演は未設定）"];
  const hasSongs = performances.some((p) => p.songs.length > 0);
  const hasCenter = performances.some((p) => p.centerSongs.length > 0);
  const hasNote = performances.some((p) => p.note.trim().length > 0);
  const headers = ["日付", "会場", ...(hasSongs ? ["追加曲"] : []), ...(hasCenter ? ["センター曲"] : []), ...(hasNote ? ["備考"] : [])];
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const p of performances) {
    const date = p.label.trim() ? `${slashDate(p.date)} ${cell(p.label)}` : slashDate(p.date);
    const cells = [date, cell(p.venue)];
    if (hasSongs) cells.push(cell(p.songs.join(" / ")));
    if (hasCenter) cells.push(cell(p.centerSongs.join(" / ")));
    if (hasNote) cells.push(cell(p.note));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  // 表の直後に置くと GFM が表の行として飲み込む (空行で表を閉じる)
  if (commonSongs.length > 0) lines.push("", `共通披露曲：${commonSongs.join(" / ")}`);
  return lines;
}

/** マーカーつきの公演の区間 (追記の差し替え単位) */
export function livePerformancesBlock(input: {
  performances: LivePerformanceInput[];
  commonSongs: string[];
}): MarkerBlock {
  return {
    start: LIVE_PERFORMANCES_START,
    end: LIVE_PERFORMANCES_END,
    lines: renderPerformancesBlock(input),
    section: {
      heading: LIVE_PERFORMANCES_HEADING,
      before: [QUOTES_HEADING, LIVE_REPORTS_LAYOUT.heading, "## 関連メディア"],
    },
  };
}

/** 記事の本文と出典を組み立てる */
export function renderLiveArticle(input: LiveRenderInput): RenderedLiveArticle {
  const title = input.name;
  const tags = ["ライブ"];

  const { blogs, talks } = classifyMaterials(input.assets);
  const { sources, talkSourceNo } = numberSources(blogs, talks);
  const quoted = quotedBlogs(blogs);
  const range = performanceRange(input.performances);
  const block = livePerformancesBlock(input);

  const body: string[] = [];

  // 1. サムネ (記事トップ)
  if (input.thumbnailUrl) {
    body.push(`<img src="${input.thumbnailUrl}" alt="${title} サムネイル" width="600">`, "");
  }

  // 2. イントロ
  const count = input.performances.length;
  body.push(
    range
      ? `${jpDateRange(range.first, range.last)}、${input.name}が開催された。坂井新奈は${count}公演に参加した。`
      : `${input.name}が開催された。`,
    ""
  );

  // 3. 公演 (毎回作り直す区間)
  body.push(LIVE_PERFORMANCES_HEADING, "");
  if (input.note.trim()) body.push(input.note.trim(), "");
  body.push(block.start, ...block.lines, block.end, "");

  // 4. 本人の感想 → 5. ファンのレポ → 6. 関連メディア (ミーグリと同じ規則)
  body.push(...renderQuotesSection(quoted));
  body.push(...renderReportsSection(input.reports, LIVE_REPORTS_LAYOUT));
  body.push(...renderRelatedMediaSection({ talks, blogs, tiktoks: input.tiktoks, talkSourceNo }));

  const live: LiveExtra["live"] = {
    name: input.name,
    common_songs: input.commonSongs,
    performances: input.performances.map((p) => ({
      date: p.date,
      venue: p.venue,
      label: p.label,
      songs: p.songs,
      center_songs: p.centerSongs,
      note: p.note,
    })),
  };
  if (input.thumbnailUrl) live.outfit_image = input.thumbnailUrl;

  return {
    title,
    tags,
    body: joinBody(body),
    sources,
    parts: {
      ...buildParts({ quoted, reports: input.reports, tiktoks: input.tiktoks, talks, blogs, talkSourceNo }),
      blocks: [block],
    },
    dates: range
      ? {
          date: range.first,
          dateDisplay: jpDateRange(range.first, range.last),
          dateMode: range.first === range.last ? null : "range",
        }
      : { date: null, dateDisplay: null, dateMode: null },
    // ミーグリと同じく下書きではない (機械で完成する)
    draft: false,
    frontmatterExtra: {
      dossier: dossierSnapshot(input.dossier, input.today),
      live,
    },
  };
}

/** 器 (Live) が組むテンプレート。追記の章の置き方はミーグリと同じで、レポの見出しだけ違う */
export const LIVE_TEMPLATE: ArticleTemplateDef = {
  key: "live",
  articleType: "event",
  needsAi: false,
  appendLayout: { ...MEETGREET_APPEND_LAYOUT, reports: LIVE_REPORTS_LAYOUT },
  // 公演の表と同じく `live:` ブロックも機械のもの。公演を直したら frontmatter にも反映する
  refreshExtraOnAppend: ["live"],
  render: null,
};
