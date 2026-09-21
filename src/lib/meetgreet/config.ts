/**
 * ミーグリ記事ワークフロー (#106) の固定値。
 *
 * 運用で変えたくなったら PR で直す (= 設定画面は持たない)。X の検索条件は
 * 既存の RepoCollection (2026-07〜08) で使っていたものをそのまま定数化した。
 */

import type { MeetGreetFormat } from "@prisma/client";
import type { HashtagGroup } from "@/lib/twitter/x-search";

/** 素材の主。この人物エンティティが付いたアセットだけを候補にする */
export const MEETGREET_PERSON_NAME = "坂井新奈";

/** 素材候補を探す日付窓 (当日〜 +N 日)。ブログは 1 週間以上あとに書かれることがある */
export const MATERIAL_WINDOW_DAYS = 10;

/** 当日〜 +N 日のトーク画像 / 動画は初期チェック済みにする */
export const TALK_SUGGEST_DAYS = 1;

/**
 * 本文にこれが含まれるブログ / トークを初期チェック済みにする。
 * 略称も正式名も本人は使うので両方 (「ミーグリ」は「オンラインミーグリ」等の部分一致で拾う)。
 */
export const MEETGREET_KEYWORDS = [
  "ミーグリ",
  "ミート＆グリート",
  "ミート&グリート",
  "ミートアンドグリート",
  "お話し会",
  "会いに来て",
  "会いにきて",
];

/** X レポ収集の期間 (当日〜 +N 日)。翌日未明の投稿まで拾う */
export const REPORT_WINDOW_DAYS = 1;

/** X レポ収集のハッシュタグ条件 (形式別)。グループ間は OR */
export function reportTagGroups(format: MeetGreetFormat): HashtagGroup[] {
  const base: HashtagGroup[] = [
    { tags: [MEETGREET_PERSON_NAME, "ミーグリ"], op: "and" },
    { tags: ["にぃぐり"], op: "and" },
  ];
  if (format === "real") {
    return [
      base[0],
      { tags: [MEETGREET_PERSON_NAME, "リアルミーグリ"], op: "and" },
      { tags: [MEETGREET_PERSON_NAME, "リアルレポ"], op: "and" },
      { tags: [MEETGREET_PERSON_NAME], op: "and" },
      base[1],
    ];
  }
  return base;
}

// --- スケッチ生成 (#108) ---
// **クライアント部品からも読むので、ここには重い依存を持ち込まない。**
// 生成の実処理 (sharp / Drive / R2 / OpenAI) は src/lib/meetgreet/sketch.ts。

/** gpt-image-1 が 1 回に受け取れる画像の総数 */
export const MAX_IMAGE_INPUTS = 16;

/**
 * 参照にできる写真の枚数。基準スケッチで 1 枚使うので 15。
 * **作り直しのときは直したい候補でもう 1 枚使う**ので、実際の上限は
 * `maxReferencePhotos()` で出すこと (ここを直に使うと 17 枚送って API に弾かれる)。
 */
export const MAX_REFERENCE_PHOTOS = MAX_IMAGE_INPUTS - 1;

/** 作り直しかどうかを踏まえた、参照写真の上限 */
export function maxReferencePhotos(isRevision: boolean): number {
  return MAX_REFERENCE_PHOTOS - (isRevision ? 1 : 0);
}

/** 1 回の生成で作る候補の枚数 */
export const SKETCH_CANDIDATE_COUNT = 2;

/** 回ごとの追加指示の長さ */
export const MAX_EXTRA_SKETCH_PROMPT = 4000;

/** 参照に選べる画像の一覧の上限 (大きいドシエで画面が重くならないように) */
export const MAX_SKETCH_SOURCES = 60;

/** 1 回の提案で読むブログの本数の上限 (LLM 呼び出しが増え続けないように) */
export const MAX_BLOGS_PER_PROPOSAL = 6;

/** 1 回に反映できる抜粋の数 */
export const MAX_EXCERPTS_PER_APPLY = 50;

/**
 * **OpenAI に送ってよい機密レベルの上限。**
 *
 * 抜粋の提案 (ブログ本文) とスケッチ生成 (画像) は、アセットの中身を外部の API に渡す。
 * confidential 以上のものは外に出さない (MCP の `akashic_apply_article_source` が
 * 公開判断を internal 以下に限っているのと同じ考え方)。詳細は docs/security-dev.md。
 */
export const MAX_EXTERNAL_AI_CLEARANCE = "internal" as const;

/**
 * 画面に並べる採用レポの上限 (#135)。
 * 「どれが載るか」を確かめるためのものなので、全部出す必要はない (判定は /repo で行う)
 */
export const MAX_KEEP_TWEETS_SHOWN = 30;

/**
 * 素材候補に添える本文の長さ (#135)。
 * トークは題だけだと何の話か分からないので数行ぶん見せる。全文は重いので切る
 */
export const CANDIDATE_TEXT_PREVIEW_CHARS = 240;

/** Json 列 (sketchCandidates / articleExclusions) から文字列だけを取り出す (中身を信用しない) */
export function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((k): k is string => typeof k === "string") : [];
}

/**
 * **生成する記事の本文に載せてよい機密レベルの上限 (#109)。**
 *
 * `Article` は非保護テーブルで、本文 (引用・トーク名・画像名) は push でそのまま
 * 公開リポジトリに載る。confidential 以上のアセットは本文にも出典にも出さない。
 * 外部 AI に渡す上限 (`MAX_EXTERNAL_AI_CLEARANCE`) と同じ線引き。
 */
export const MAX_ARTICLE_CLEARANCE = "internal" as const;
