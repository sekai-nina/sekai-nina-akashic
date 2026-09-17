import { randomInt } from "node:crypto";
import * as z from "zod";
import { $Enums, type ArticleType } from "@prisma/client";

import { ARTICLE_TYPE_LABELS, describeEnum } from "@/lib/utils";

import { parseArticleEditForm, type ArticleEditValues, type ParsedArticleEditForm } from "./edit";
import { parseFrontmatterDate } from "./frontmatter";
import { ArticleEditPatchSchema, mergeArticleEditPatch } from "./patch";

/**
 * 外部 (REST `POST /api/v1/articles` / MCP `akashic_create_article`) からの記事の新規作成。
 *
 * ここは採番と入力の組み立てだけの純粋関数にして vitest で押さえる (DB は domain の
 * `createArticle`)。採番規則は #104 の設計合意:
 *
 * - `shortId` は 7 桁 base62 のランダム。公開サイトの `scripts/assign-slugs.ts` と同じ字母で、
 *   公開サイトのビルドは `short_id` 欠落を検出して落ちるので作成時に必ず振る。クライアントには
 *   指定させない (`@unique` 衝突は domain が再採番する)
 * - `path` は `<type>/<ファイル名>.md`。実データの 335 本中 304 本がこの形で、ディレクトリと
 *   `ArticleType` は 1:1。例外は `quiz/{beginner,intermediate,advanced}/` の 3 本 (type は `attribute`) で、
 *   path を必ず `<type>/` 始まりにするこの API からは作れない
 * - `slug` は null 固定 (実データ 0 件。公開サイトの URL は `short_id`)、`frontmatterExtra` は `{}`
 */

/** `assign-slugs.ts` の ALPHABET と同じ並び (A-Z a-z 0-9) */
const SHORT_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const SHORT_ID_LENGTH = 7;

/** 7 桁 base62。暗号学的乱数 (`randomInt`) を使うのは `assign-slugs.ts` と同じ */
export function generateShortId(): string {
  let id = "";
  for (let i = 0; i < SHORT_ID_LENGTH; i++) id += SHORT_ID_ALPHABET[randomInt(SHORT_ID_ALPHABET.length)];
  return id;
}

/**
 * ファイル名に使えない ASCII 9 文字 → 全角。
 *
 * 実データは `Yes, me now?` を `quote/Yes, me now？.md` として保存している (タイトルはそのまま、
 * ファイル名だけ全角)。Obsidian もこの 9 文字をファイル名に許さないので、そのまま書くと
 * 公開リポジトリに Obsidian で開けないファイルが入る。quote 記事は曲名や発言をそのまま
 * タイトルにするので、タイトル側を弾くのではなくファイル名側で置き換える。
 */
const FILENAME_SUBSTITUTIONS: Readonly<Record<string, string>> = {
  "/": "／",
  "\\": "＼",
  ":": "：",
  "*": "＊",
  "?": "？",
  '"': "”",
  "<": "＜",
  ">": "＞",
  "|": "｜",
};

/** 制御文字 (C0 / DEL / C1)。ファイル名に入れない */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * ファイル名 1 要素の上限 (バイト)。ext4 / APFS の制限。実データの最長は 147 バイト。
 * GitHub 側には制限が無いが、checkout できないファイルを公開リポジトリに入れない
 */
export const FILENAME_MAX_BYTES = 255;

export type DerivedArticlePath = { ok: true; path: string } | { ok: false; error: string };

/**
 * タイトル → リポジトリ内の path。順に NFC 正規化 → 制御文字除去 → 全角置換 → trim。
 *
 * - NFC にするのは #88 と同じ理由 (macOS の NFD ファイル名と GitHub の tree (NFC) の食い違いを
 *   API 側では最初から作らない)
 * - `.` / `_` 始まりは Astro がコレクションから無視する (`_templates/` と同じ扱いになる) ので 400
 * - `readme` を **含む** ファイル名は 400。公開サイトの `EXCLUDED_SLUGS` (`["readme", "_template/",
 *   "_templates/"]`) は `slug.includes(ex)` の **部分一致** なので、`このReadMeについて.md` も
 *   描画対象から外れる = `short_id` も振られない。完全一致に絞るとそういう記事を作れてしまう
 * - 255 バイト超は checkout できない
 *
 * 作成後のタイトル変更で path は追随しない (PATCH と同じ。実データにもタイトルと path が
 * 一致しない記事が 31 本ある)。
 */
export function deriveArticlePath(type: ArticleType, title: string): DerivedArticlePath {
  const filename = title
    .normalize("NFC")
    .replace(CONTROL_CHARS, "")
    .replace(/[/\\:*?"<>|]/g, (c) => FILENAME_SUBSTITUTIONS[c])
    .trim();
  if (filename === "") return { ok: false, error: "タイトルが空です" };
  if (filename.startsWith(".") || filename.startsWith("_")) {
    return { ok: false, error: "タイトルを . や _ で始めることはできません (公開サイトが無視するファイル名になる)" };
  }
  if (filename.toLowerCase().includes("readme")) {
    return { ok: false, error: "タイトルに readme を含めることはできません (公開サイトが除外するファイル名になる)" };
  }
  const name = `${filename}.md`;
  if (Buffer.byteLength(name, "utf8") > FILENAME_MAX_BYTES) {
    return { ok: false, error: `タイトルが長すぎます (ファイル名が ${FILENAME_MAX_BYTES} バイトを超える)` };
  }
  return { ok: true, path: `${type}/${name}` };
}

/**
 * 作成の入力。PATCH と同じ 12 項目のうち `title` と `type` を必須にし、残りは省略可。
 * 省略時の既定値は `buildArticleCreateForm` が入れる。未知のキーは PATCH と同じく除去。
 */
export const ArticleCreateSchema = ArticleEditPatchSchema.extend({
  title: z.string().trim().min(1, "タイトルは必須です").describe("タイトル (必須)。path のファイル名にもなる"),
  type: z
    .enum($Enums.ArticleType)
    .describe(`記事種別 (必須)。${describeEnum(ARTICLE_TYPE_LABELS)}。path のディレクトリになる`),
  draft: ArticleEditPatchSchema.shape.draft.describe(
    "下書き。既定 true。**公開サイトの記事ページに出ないだけで、ファイル自体は次の push で公開リポジトリに載る**",
  ),
  publishedAt: ArticleEditPatchSchema.shape.publishedAt.describe(
    "公開日 (YYYY-MM-DD)。省略すると今日 (JST)。null / 空で無し",
  ),
  articleUpdatedAt: ArticleEditPatchSchema.shape.articleUpdatedAt.describe(
    "更新日 (YYYY-MM-DD)。省略すると今日 (JST)。null / 空で無し",
  ),
});

export type ArticleCreateInput = z.infer<typeof ArticleCreateSchema>;

/**
 * 省略された項目の既定値。`today` は JST の "YYYY-MM-DD" (`todayJst()`)。
 *
 * - `draft: true`: 公開サイトの記事ページに出さない。**push そのものは止めないので、本文は
 *   公開リポジトリ (sekai-nina-public、public) に載る。** 機密を本文に書かせない担保は別
 *   (`docs/security-dev.md`。`Article` は非保護テーブルで、本文の書き込みに classification の
 *   ガードは無い)。呼び出し側が `draft: false` を明示すればそのまま公開サイトにも出る
 * - `publishedAt` / `articleUpdatedAt` = 今日: Obsidian のテンプレートと同じ。AI に「今日」を
 *   計算させると UTC で 1 日ずれる (#93-2) ので、省略時はサーバが JST で入れる
 * - `date` は null: event 以外はほぼ空 (実データ 335 本中 94 本)。出来事の日は AI が明示する
 */
export function articleCreateDefaults(today: string): ArticleEditValues {
  const todayDate = parseFrontmatterDate(today);
  return {
    title: "",
    type: null,
    tags: [],
    body: "",
    date: null,
    dateDisplay: null,
    dateMode: null,
    publishedAt: todayDate,
    articleUpdatedAt: todayDate,
    draft: true,
    unlisted: false,
    ongoing: false,
  };
}

/**
 * 作成の入力を、PATCH と同じ経路 (`mergeArticleEditPatch` → `parseArticleEditForm`) で
 * `ArticleEditValues` にする。正規化 (CRLF / 先頭空行 / タグの trim) と検証 (暦に無い日付 /
 * 本文の長さ) が PATCH や編集 UI とズレない。省略 (`undefined`) は既定値、`null` / `""` は空。
 *
 * **タイトルは NFC 化と制御文字の除去だけ。全角置換はしない** (それはファイル名側の都合)。
 *
 * - NFC: path だけ正規化してタイトルを素のまま保存すると、NFD のタイトルが frontmatter に載り、
 *   完全一致で解決する `[[タイトル]]` (`remarkWikilinks` / `countArticlesLinkingTo`) から
 *   永久に辿れない記事ができる
 * - 制御文字: zod の `.trim()` は NUL を落とさないので `"癖\u0000"` が検証を通る。**Postgres の
 *   `text` は NUL を格納できない**ので、そのまま書くと P2002 でない例外になり REST は 500 になる。
 *   他の C0 文字は格納できてしまい、公開リポジトリの `title:` に不可視文字が載る
 */
export function parseArticleCreateInput(input: ArticleCreateInput, today: string): ParsedArticleEditForm {
  const title = input.title.normalize("NFC").replace(CONTROL_CHARS, "");
  return parseArticleEditForm(mergeArticleEditPatch(articleCreateDefaults(today), { ...input, title }));
}
