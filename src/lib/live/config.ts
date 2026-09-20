/**
 * ライブ記事ワークフロー (#148) の固定値。
 *
 * 日付の窓・外部 AI に渡す上限・記事に載せてよい機密はミーグリ (`src/lib/meetgreet/config.ts`)
 * と同じ値を使う。ここにはライブで違うものだけを置く。
 */

import type { HashtagGroup } from "@/lib/twitter/x-search";
import { MEETGREET_PERSON_NAME } from "@/lib/meetgreet/config";

/**
 * 本文にこれが含まれるブログ / トークを初期チェック済みにする。
 * ライブ名・会場名は回ごとに違うので、呼び出し側 (`liveKeywords`) が足す。
 */
export const LIVE_KEYWORDS = [
  "ライブ",
  "公演",
  "ツアー",
  "セトリ",
  "セットリスト",
  "コンサート",
  "フェス",
  "アンコール",
  "リハ",
];

/**
 * ライブ名と会場名をキーワードに足す。
 * ライブ名はブログで「MONSTER GROOVE」のように鍵括弧の中だけ書かれることが多いので、
 * `「」` の中身も別に足す。短すぎる断片 (2 文字未満) は何にでも当たるので入れない
 */
export function liveKeywords(live: { name: string; venues: string[] }): string[] {
  const out = new Set<string>(LIVE_KEYWORDS);
  const add = (s: string) => {
    const t = s.trim();
    if ([...t].length >= 2) out.add(t);
  };
  add(live.name);
  for (const m of live.name.matchAll(/「([^」]+)」/g)) add(m[1]);
  for (const v of live.venues) {
    add(v);
    // 「セキスイハイムスーパーアリーナ（宮城）」→ 括弧の前も足す
    const base = v.replace(/[（(].*$/, "");
    add(base);
  }
  return [...out];
}

/**
 * X レポ収集のハッシュタグ条件。**坂井新奈 AND 各タグ**、タグ間は OR。
 * タグが無ければ坂井新奈だけ (リアルミーグリの `#坂井新奈` 単独と同じ)
 */
export function liveReportTagGroups(tags: readonly string[]): HashtagGroup[] {
  const clean = [...new Set(tags.map((t) => t.trim().replace(/^#/, "")).filter(Boolean))];
  if (clean.length === 0) return [{ tags: [MEETGREET_PERSON_NAME], op: "and" }];
  return clean.map((t) => ({ tags: [MEETGREET_PERSON_NAME, t], op: "and" }));
}

// --- 入力の上限 (画面・REST 共通)。**クライアント部品からも読むので zod を持ち込まない** ---

/**
 * ライブ名の長さ (文字数)。記事のファイル名 (= タイトル + `.md`) は 255 バイト以内なので、
 * 日本語なら 3 バイト × 80 = 240 バイトに収まる 80 文字にしておく
 */
export const MAX_LIVE_NAME = 80;

/** 補足の長さ */
export const MAX_LIVE_NOTE = 2000;

/** 会場名 / 呼び分け (昼公演等) / 公演の備考 の長さ */
export const MAX_VENUE = 200;
export const MAX_PERFORMANCE_LABEL = 50;
export const MAX_PERFORMANCE_NOTE = 500;

/** 1 つのライブに持てる公演の数 (ツアーでも 20 前後) */
export const MAX_PERFORMANCES = 100;

/** 1 つの曲リストに入れられる曲数 */
export const MAX_SONGS_PER_LIST = 100;

/** 曲名の長さ */
export const MAX_SONG_TITLE = 100;

/**
 * 「A / B / C」の 1 行入力を曲名の配列にする。
 * 区切りは ` / ` (全角スラッシュも可)。空と重複は落とす。
 * 読点では割らない (曲名に入りうる)
 */
export function splitSongs(input: string): string[] {
  const out: string[] = [];
  for (const raw of input.split(/\s*[/／]\s*/)) {
    const t = raw.replace(/\s+/g, " ").trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** 配列を 1 行入力に戻す */
export function joinSongs(songs: readonly string[]): string {
  return songs.join(" / ");
}
