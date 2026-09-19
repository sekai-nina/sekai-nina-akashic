/**
 * X 言及監視のクエリ組み立て (純関数。DB も X API も触らない)。
 *
 * 監視語は X の検索クエリをそのまま持つ (`"坂井新奈"` / `にいなちゃん OR にーなちゃん` 等)。
 * 実行時にリツイート除外と除外ユーザーの `-from:` を後ろに足す。
 */

/** X API のクエリ長上限 (Basic プラン。Pro は 1024 だが安全側に倒す) */
export const X_QUERY_MAX_CHARS = 512;
/** 監視語の長さ上限。`-is:retweet` と `-from:` を足す余地を残す */
export const WATCH_QUERY_MAX_CHARS = 200;
/** 除外ユーザー (XMentionSetting) の行 ID。行は 1 つだけ */
export const SETTING_ID = "singleton";
/** /status に残すハートビートの key */
export const JOB_KEY = "cron.x_mentions";

/** X のユーザー名 (@ 抜き)。英数字とアンダースコア、15 文字まで */
const USERNAME_PATTERN = /^[a-z0-9_]{1,15}$/;

/**
 * 入力されたユーザー名を突き合わせ用に正規化する (`@Foo_Bar ` → `foo_bar`)。
 * X のユーザー名は大文字小文字を区別しないので小文字に寄せる。全角の ＠ も落とす。形が違えば null
 */
export function normalizeUsername(raw: string): string | null {
  const s = raw.trim().replace(/^[@＠]+/, "").toLowerCase();
  return USERNAME_PATTERN.test(s) ? s : null;
}

/** 監視語の入力を整える (連続空白を 1 つに)。空や長すぎるものは Error */
export function normalizeWatchQuery(raw: string): string {
  const q = raw.replace(/\s+/g, " ").trim();
  if (!q) throw new Error("監視語を入力してください");
  if (q.length > WATCH_QUERY_MAX_CHARS) throw new Error(`監視語は ${WATCH_QUERY_MAX_CHARS} 文字までです`);
  return q;
}

/**
 * 除外ユーザーの入力 (改行・カンマ・空白区切り) をユーザー名の配列にする。
 * 形が違うものは `invalid` に分けて返す (画面で指摘する)
 */
export function parseUsernames(input: string): { usernames: string[]; invalid: string[] } {
  const usernames = new Set<string>();
  const invalid: string[] = [];
  for (const token of input.split(/[\s,、]+/)) {
    if (!token) continue;
    const u = normalizeUsername(token);
    if (u) usernames.add(u);
    else invalid.push(token);
  }
  return { usernames: [...usernames], invalid };
}

export interface BuiltQuery {
  query: string;
  /** クエリに `-from:` として入れられた除外ユーザー。入りきらなかった分はアプリ側で落とす */
  excludedInQuery: string[];
}

/**
 * 監視語 + `-is:retweet` + 除外ユーザーの `-from:` を、クエリ長の上限まで詰める。
 *
 * X のクエリは AND が OR より強く結合するので、監視語は必ず括弧で包む
 * (`A OR B -is:retweet` は `A OR (B -is:retweet)` になり、A のリツイートが漏れる)。
 * `-from:` はクエリ側で除外したほうが X API の読み取り枠を食わないので優先して入れるが、
 * 上限に入りきらない分は取ってきてから `isExcluded` で落とす (結果は同じ)。
 */
export function buildMentionQuery(watchQuery: string, excludedUsernames: string[]): BuiltQuery {
  const base = `(${watchQuery.trim()}) -is:retweet`;
  let query = base;
  const excludedInQuery: string[] = [];
  for (const u of excludedUsernames) {
    const next = `${query} -from:${u}`;
    if (next.length > X_QUERY_MAX_CHARS) break;
    query = next;
    excludedInQuery.push(u);
  }
  return { query, excludedInQuery };
}

/** 投稿者が除外ユーザーか (大文字小文字を無視) */
export function isExcluded(authorUsername: string, excludedUsernames: string[]): boolean {
  const u = authorUsername.trim().replace(/^[@＠]+/, "").toLowerCase();
  return excludedUsernames.includes(u);
}

/** X の snowflake ID の起点 (2010-11-04T01:42:54.657Z)。ID の上位ビットがここからのミリ秒 */
const SNOWFLAKE_EPOCH_MS = 1_288_834_800_000;

/**
 * ツイート ID から投稿時刻 (ms) を出す。since_id が recent search の 7 日窓より古いかを、
 * 「最後に確認した時刻」ではなく ID 自体から判定するため (確認だけ毎日していても ID は進まない)。
 * 形が数字でなければ null
 */
export function tweetIdTimestampMs(id: string | null): number | null {
  if (!id || !/^\d+$/.test(id)) return null;
  return Number(BigInt(id) >> 22n) + SNOWFLAKE_EPOCH_MS;
}

/**
 * ツイート ID の大きいほう (= 新しいほう) を返す。ID は 64bit を超えることがあるので
 * Number に落とさず BigInt で比べる。形が数字でないものは無視する
 */
export function newerTweetId(a: string | null, b: string | null): string | null {
  const va = a && /^\d+$/.test(a) ? BigInt(a) : null;
  const vb = b && /^\d+$/.test(b) ? BigInt(b) : null;
  if (va === null) return vb === null ? null : b;
  if (vb === null) return a;
  return va >= vb ? a : b;
}
