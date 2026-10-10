/**
 * ミーグリページに出すファンレポ (#210) の純粋関数。
 *
 * ミーグリ記事の「レポ」章は採用したツイートを `![](https://x.com/…/status/…)` で埋め込む。
 * そのうち世界新奈の `/meetgreet` に出すものは `![rep](…)` に書き換えてある。サイトは
 * 新しい記事から順に `![rep]` を拾って最大 9 件を出す (sekai-nina-site `src/utils/meetgreet.ts`
 * の `collectReports`)。**選択結果の正は記事本文のマーカー**で、ここはその読み書きだけを持つ。
 */

/** サイトに出る件数 (sekai-nina-site の `collectReports` の既定と同じ) */
export const SITE_FEATURED_REPORTS_LIMIT = 9;

/** サイトの `FEATURED_REP_RE` と同じ形。行の中のどこにあっても拾う */
const FEATURED_RE = /!\[rep\]\((https:\/\/(?:x|twitter)\.com\/[^)]+\/status\/\d+)[^)]*\)/g;

/**
 * 1 行に 1 つ置かれたレポの埋め込み (`![](url)` / `![rep](url)`)。
 * 記事テンプレート (`renderReportsSection`) は必ずこの形で書くので、行の途中や
 * `x.com/i/web/status/…` の形は扱わない (サイトの正規表現はそれも拾うが、実データに無い)
 */
const EMBED_LINE_RE = /^(\s*)!\[(rep)?\]\((https:\/\/(?:x|twitter)\.com\/[^)\s/]+\/status\/(\d+))([^)]*)\)\s*$/;

export interface ReportEmbed {
  tweetId: string;
  url: string;
  /** `![rep]` になっている = サイトに出す */
  featured: boolean;
}

/**
 * 本文中のレポの埋め込みを出現順に。同じツイートが 2 回あれば 1 つにまとめ、
 * どちらかが `![rep]` なら featured (サイトにはもう出ている)
 */
export function listReportEmbeds(body: string): ReportEmbed[] {
  const byId = new Map<string, ReportEmbed>();
  for (const line of body.split("\n")) {
    const m = line.match(EMBED_LINE_RE);
    if (!m) continue;
    const prev = byId.get(m[4]);
    if (prev) prev.featured ||= m[2] === "rep";
    else byId.set(m[4], { tweetId: m[4], url: m[3], featured: m[2] === "rep" });
  }
  return [...byId.values()];
}

/**
 * 指定ツイートの埋め込みを `![rep]` (on) / `![]` (off) に書き換える。
 * 同じツイートが 2 回あるときは、on は最初の 1 つだけ (サイトに 2 回出さない)、off はすべて外す。
 * 埋め込みが本文に無ければ null (記事を作り直したあとに古い画面から押した等)。
 * 既にその状態なら本文をそのまま返す
 */
export function setReportFeatured(body: string, tweetId: string, on: boolean): string | null {
  let seen = 0;
  const next = body.split("\n").map((line) => {
    const m = line.match(EMBED_LINE_RE);
    if (!m || m[4] !== tweetId) return line;
    const rep = on && seen === 0;
    seen++;
    return `${m[1]}![${rep ? "rep" : ""}](${m[3]}${m[5]})`;
  });
  return seen > 0 ? next.join("\n") : null;
}

/** サイトの `collectReports` と同じ拾い方で、`![rep]` の URL を本文の出現順に */
export function featuredReportUrls(body: string): string[] {
  return [...body.matchAll(FEATURED_RE)].map((m) => m[1]);
}

export function tweetIdOf(url: string): string | null {
  return url.match(/\/status\/(\d+)/)?.[1] ?? null;
}
