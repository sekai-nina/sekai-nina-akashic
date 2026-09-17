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
