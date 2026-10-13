/**
 * 出演一覧の記事の表に 1 回分の行を足す純粋関数 (`/progress/<番組>` の「行を足す」)。
 *
 * Discord bot の 📤 (`sekai-nina-discord-bot/src/lemino_article/article.py`) と同じ規則:
 * - 行は回番号順に挿入し、既存の行は触らない
 * - 年度別の記事 (`【N年目】…出演一覧`) は「開始の回番号が num 以下で最大の記事」を選ぶ
 *
 * bot と違って列は表の見出しから決める (ひなあいは 言動 / 補足、ひななりは ゲスト)。
 * 番外編は本編と同じ回番号に枝番 (`20a`) を付けた別の行にする。
 */

/** 表の 1 列目の `| 383 |` / `| 20a |` */
const ROW_RE = /^\|\s*(\d+)([a-z]?)\s*\|/;
const SEPARATOR_RE = /^\|(\s*:?-+:?\s*\|)+\s*$/;

export interface ListRowInput {
  episode: number;
  /** 番外編の枝番 (`a`)。本編は空 */
  suffix: string;
  /** "YYYY-MM-DD" */
  date: string;
  title: string;
  /** タイトルのリンク先。無ければリンクにしない */
  url: string | null;
  /** 見出しの列名 → 値 (言動 / 補足 / ゲスト)。見出しに無い列は捨てる */
  cells: Record<string, string>;
}

export interface TableRow {
  episode: number;
  suffix: string;
}

/** 最初の表の区切り行と、表の終わり (表の外の最初の行)。表が無ければ null */
function tableRegion(lines: string[]): { sep: number; end: number } | null {
  const sep = lines.findIndex((l, i) => i > 0 && SEPARATOR_RE.test(l) && lines[i - 1].trimStart().startsWith("|"));
  if (sep < 0) return null;
  let end = sep + 1;
  while (end < lines.length && lines[end].trimStart().startsWith("|")) end++;
  return { sep, end };
}

/** 表の見出し (`| # | 日付 | … |`) の列名。表が無ければ null */
export function tableColumns(body: string): string[] | null {
  const lines = body.split("\n");
  const region = tableRegion(lines);
  return region ? splitCells(lines[region.sep - 1]) : null;
}

/** 最初の表の回の行 (本文のほかの表や `| 1 |` で始まる行は見ない) */
export function tableRows(body: string): TableRow[] {
  const lines = body.split("\n");
  const region = tableRegion(lines);
  if (!region) return [];
  return lines.slice(region.sep + 1, region.end).flatMap((l) => {
    const m = l.match(ROW_RE);
    return m ? [{ episode: Number(m[1]), suffix: m[2] }] : [];
  });
}

/** 本編の行があるか / 番外編なら次に使う枝番 */
export function nextSuffix(body: string, episode: number, extra: boolean): string | null {
  const used = tableRows(body).filter((r) => r.episode === episode).map((r) => r.suffix);
  if (!extra) return used.includes("") ? null : "";
  for (const c of "abcdefghijklmnopqrstuvwxyz") if (!used.includes(c)) return c;
  return null;
}

/**
 * 行を足した本文を返す。表が無い・同じ行が既にあるときは投げる。
 * 空の表 (見出しと区切りだけ) にも足せる (新年度の記事を作った直後)。
 * 回番号の無い行 (`| 合計 |` 等) は順序の判定に使わない。
 */
export function insertListRow(body: string, row: ListRowInput): string {
  const lines = body.split("\n");
  const region = tableRegion(lines);
  if (!region) throw new Error("記事に表が見つかりません");
  const columns = splitCells(lines[region.sep - 1]);
  const key = (ep: number, suffix: string) => ep * 100 + (suffix ? suffix.charCodeAt(0) - 96 : 0);
  const newKey = key(row.episode, row.suffix);

  let insertAt = region.sep + 1;
  for (let i = region.sep + 1; i < region.end; i++) {
    const m = lines[i].match(ROW_RE);
    if (!m) continue;
    const k = key(Number(m[1]), m[2]);
    if (k === newKey) throw new Error(`表に #${row.episode}${row.suffix} の行が既にあります`);
    if (k < newKey) insertAt = i + 1;
  }

  const values = columns.map((c) => cellFor(c, row));
  const line = `| ${values.join(" | ")} |`;
  return [...lines.slice(0, insertAt), line, ...lines.slice(insertAt)].join("\n");
}

/**
 * 回番号を入れる年度別の記事 (添字)。bot の `pick_year_by_episode` と同じ。
 * 既にその回を含む記事 → 最新年度が空で既存の最大を超える回ならそこ → 開始の回番号が num 以下で最大の記事
 * → どれより前なら最も古い年度 (bot は最新年度に入れるが、古い回の書き足しで誤る)。
 */
export function pickYearArticle(articles: { title: string; body: string }[], episode: number): number {
  if (articles.length === 0) throw new Error("年度別の出演一覧の記事がありません");
  const yearOf = (i: number) => Number(articles[i].title.match(/【(\d+)年目】/)?.[1] ?? 0);
  const eps = articles.map((a) => tableRows(a.body).map((r) => r.episode));

  const has = eps.findIndex((ns) => ns.includes(episode));
  if (has >= 0) return has;

  const idx = articles.map((_, i) => i);
  const newest = idx.reduce((a, b) => (yearOf(b) > yearOf(a) ? b : a));
  const nonEmpty = idx.filter((i) => eps[i].length > 0);
  if (nonEmpty.length) {
    const overallMax = Math.max(...nonEmpty.flatMap((i) => eps[i]));
    if (eps[newest].length === 0 && episode > overallMax) return newest;
    const below = nonEmpty.filter((i) => Math.min(...eps[i]) <= episode);
    if (below.length) return below.reduce((a, b) => (Math.min(...eps[b]) > Math.min(...eps[a]) ? b : a));
    // どの記事の開始より前の回は最も古い年度へ
    return idx.reduce((a, b) => (yearOf(b) < yearOf(a) ? b : a));
  }
  return newest;
}

/** `2026-06-15` → `2026/6/15` (既存の表に合わせてゼロ埋めしない) */
export function mdDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y}/${m}/${d}`;
}

function cellFor(column: string, row: ListRowInput): string {
  if (column === "#") return `${row.episode}${row.suffix}`;
  if (column === "日付" || column === "配信日" || column === "放送日") return mdDate(row.date);
  if (column === "タイトル") return row.url ? `[${escapeLinkText(row.title)}](${escapeUrl(row.url)})` : escapeCell(row.title);
  return escapeCell(row.cells[column] ?? "");
}

function splitCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** セルの中の改行は `<br>`、`|` は表を壊すのでエスケープ */
function escapeCell(s: string): string {
  return s.replace(/\r\n?/g, "\n").trim().replace(/\n/g, "<br>").replace(/\|/g, "\\|");
}

/** リンク先の `(` `)` 空白 `|` はリンクと表を壊すのでパーセントエンコード */
function escapeUrl(url: string): string {
  // encodeURIComponent は ( ) をエンコードしない
  return url.trim().replace(/[()\s|]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

function escapeLinkText(s: string): string {
  return escapeCell(s).replace(/[[\]]/g, (c) => `\\${c}`);
}
