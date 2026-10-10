/**
 * 言葉記事の「名言集に載せる一節」(`{q}…{/q}`) の純粋関数 (#206)。
 *
 * 世界新奈の `/quotes` は言葉記事 (`type: quote`) の本文から `{q}…{/q}` だけを拾う
 * (sekai-nina-site `src/utils/quotes.ts` の `extractQuotes`)。言葉記事テンプレートは `{q}` を付けないので、
 * 人が引用の段落ごとに選ぶ。**選択結果の正は記事本文のマーカー**で、ここはその読み書きだけを持つ。
 *
 * 単位は「引用ブロック」= `>` で始まる行の連なり (空行・地の文で切れる。`>` だけの行は切らない)。
 * テンプレートは抜粋 1 つを 1 ブロックにして書くので (抜粋の中の空行は `>` になる)、ブロック = 抜粋になる。
 * 既存記事は抜粋の中の段落をまたいで `{q}` を付けていることが多いので、`>` だけの行で切ると対応が壊れる。
 * 手でブロックの途中に付けた `{q}` は「載せている」として扱い、付けるときは触らない。
 */

/** サイトの `quoteRegex` と同じ形 (`{q}` / `{q id="…"}` … `{/q}`) */
const SITE_QUOTE_RE = /\{q(?:\s+id=["']([^"']+)["'])?\}([\s\S]*?)\{\/q\}/g;
const OPEN_RE = /\{q(?:\s+id=["'][^"']+["'])?\}/g;
const CLOSE_RE = /\{\/q\}/g;
/** 引用行。`>` の直後の空白 1 つまでを接頭辞に含める (書き戻すときにそのまま残す) */
const QUOTE_LINE_RE = /^(\s*>\s?)(.*)$/;

export interface PassageSegment {
  text: string;
  /** `{q}…{/q}` の中 (名言集に載る) */
  quoted: boolean;
}

export interface QuotePassage {
  /** 本文中の引用ブロックの通し番号 (0 始まり)。付け外しの指定に使う */
  index: number;
  /** マーカーを除いた本文 (改行は残す) */
  text: string;
  /** 名言集に載る部分と載らない部分 */
  segments: PassageSegment[];
  /** 段落のどこかに `{q}` がある */
  quoted: boolean;
  /**
   * マーカーが段落の中で閉じていない (段落をまたぐ `{q}` を手で付けた)。
   * 付け外しすると対応が壊れるので、画面からは触らせない
   */
  unbalanced: boolean;
}

interface PassageRange {
  /** 本文の行番号 (両端含む) */
  start: number;
  end: number;
}

function isFilled(line: string): boolean {
  const m = line.match(QUOTE_LINE_RE);
  return !!m && m[2].trim() !== "";
}

/** 引用ブロックの範囲。前後の `>` だけの行は含めない (中身の無いブロックは出さない) */
function passageRanges(lines: string[]): PassageRange[] {
  const ranges: PassageRange[] = [];
  let start = -1;
  const close = (end: number) => {
    let s = start;
    let e = end;
    while (s <= e && !isFilled(lines[s])) s++;
    while (e >= s && !isFilled(lines[e])) e--;
    if (s <= e) ranges.push({ start: s, end: e });
    start = -1;
  };
  lines.forEach((line, i) => {
    const quote = QUOTE_LINE_RE.test(line);
    if (quote && start < 0) start = i;
    if (!quote && start >= 0) close(i - 1);
  });
  if (start >= 0) close(lines.length - 1);
  return ranges;
}

function contentOf(line: string): string {
  return line.match(QUOTE_LINE_RE)?.[2] ?? line;
}

/** 開きと閉じが順に対応しているか (`{/q}…{q}` のように隣のブロックへ続くものは対応していない) */
function balanced(raw: string): boolean {
  let depth = 0;
  for (const m of raw.matchAll(/\{q(?:\s+id=["'][^"']+["'])?\}|\{\/q\}/g)) {
    depth += m[0] === "{/q}" ? -1 : 1;
    if (depth < 0 || depth > 1) return false;
  }
  return depth === 0;
}

/** 取り込んだ本文は CRLF のことがある。行単位で見るので LF に揃える */
function toLines(body: string): string[] {
  return body.replace(/\r\n?/g, "\n").split("\n");
}

/** マーカー付きの段落本文を、載る / 載らない部分に分ける。閉じていない `{q}` は末尾までを載る扱いにする */
function segmentsOf(raw: string): PassageSegment[] {
  const out: PassageSegment[] = [];
  let quoted = false;
  for (const part of raw.split(/(\{q(?:\s+id=["'][^"']+["'])?\}|\{\/q\})/)) {
    if (part.startsWith("{q")) quoted = true;
    else if (part === "{/q}") quoted = false;
    else if (part) {
      const last = out[out.length - 1];
      if (last && last.quoted === quoted) last.text += part;
      else out.push({ text: part, quoted });
    }
  }
  return out;
}

export function listQuotePassages(body: string): QuotePassage[] {
  const lines = toLines(body);
  return passageRanges(lines).map((r, index) => {
    const raw = lines.slice(r.start, r.end + 1).map(contentOf).join("\n");
    const segments = segmentsOf(raw);
    return {
      index,
      text: segments.map((s) => s.text).join(""),
      segments,
      quoted: /\{q(?:\s+id=["'][^"']+["'])?\}|\{\/q\}/.test(raw),
      unbalanced: !balanced(raw),
    };
  });
}

/**
 * 段落を名言集に載せる (on) / 外す (off)。
 * - on: 段落全体を `{q}…{/q}` で包む。既に一部でも載っていればそのまま (手で選んだ範囲を広げない)
 * - off: 段落の中のマーカーをすべて外す
 *
 * ブロックが無い・`expectedText` (画面に出した本文) と食い違う・マーカーが閉じていないときは null
 * (画面を開いたあとに本文が変わった / 手で直す必要がある)。既にその状態なら本文をそのまま返す
 */
export function setPassageQuoted(body: string, index: number, on: boolean, expectedText?: string): string | null {
  const lines = toLines(body);
  const range = passageRanges(lines)[index];
  if (!range) return null;
  const passage = listQuotePassages(body)[index];
  if (passage.unbalanced) return null;
  if (expectedText !== undefined && passage.text !== expectedText) return null;
  if (passage.quoted === on) return body;

  if (on) {
    const first = lines[range.start].match(QUOTE_LINE_RE)!;
    lines[range.start] = `${first[1]}{q}${first[2]}`;
    lines[range.end] = `${lines[range.end]}{/q}`;
  } else {
    for (let i = range.start; i <= range.end; i++) {
      const m = lines[i].match(QUOTE_LINE_RE)!;
      lines[i] = m[1] + m[2].replace(OPEN_RE, "").replace(CLOSE_RE, "");
    }
  }
  return lines.join("\n");
}

/** サイトの `extractQuotes` と同じ拾い方で、名言集に載る件数 (空の `{q}{/q}` は数えない) */
export function countSiteQuotes(body: string): number {
  const clean = body.replace(/^>\s?/gm, "");
  return [...clean.matchAll(SITE_QUOTE_RE)].filter((m) => m[2].trim().length > 0).length;
}
