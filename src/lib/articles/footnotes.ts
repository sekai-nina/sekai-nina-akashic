/**
 * 記事本文の記法を読み解く。
 *
 * - `^[n]` — 脚注。frontmatter の `source[].id` に対応する
 * - `[[記事タイトル]]` — Obsidian 由来の記事間リンク (実データで 79 記事・142 箇所)
 *
 * 記事を読むときの中心的な作業が「この記述の出典はどれか」「この語は
 * どの記事か」を辿ることなので、どちらもリンクにする。あわせて対応が
 * 壊れている箇所を出す。
 */

const FOOTNOTE_RE = /\^\[(\d+)\]/g;
/** `[[タイトル]]` / `[[タイトル|表示名]]` */
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;

/**
 * wikilink の宛先を正規化する。
 *
 * Obsidian は Markdown テーブル内の wikilink で `|` を `\|` にエスケープするので、
 * 宛先の末尾に `\` が残る (実データで 1 記事 4 箇所)。落とさないと実在する
 * 記事に解決できず、偽の「宛先の無い記事リンク」警告になる。
 */
const normalizeTarget = (raw: string) => raw.replace(/\\+$/, "").trim();
/** 本文の記法をまとめて拾う (位置順に処理するため 1 本にする) */
const MARKUP_RE = new RegExp(`${FOOTNOTE_RE.source}|${WIKILINK_RE.source}`, "g");

/** 本文に現れる脚注番号を、出現順・重複なしで返す */
export function footnoteRefsInBody(body: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const m of body.matchAll(FOOTNOTE_RE)) {
    const n = Number(m[1]);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** 本文に現れる `[[...]]` の中身を出現順・重複なしで返す */
export function wikiLinkTargetsInBody(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(WIKILINK_RE)) {
    const t = normalizeTarget(m[1]);
    if (t === "" || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export type BodySegment =
  | { kind: "text"; text: string }
  | { kind: "footnote"; num: number; known: boolean }
  /** 解決できた記事間リンク */
  | { kind: "link"; label: string; shortId: string }
  /** 解決できなかった `[[...]]`。そのまま出す */
  | { kind: "deadLink"; label: string; target: string };

/**
 * 本文を描画用のセグメントに分解する。
 *
 * @param knownFootnotes 対応する出典がある脚注番号
 * @param shortIdByTitle 記事タイトル → shortId
 */
export function parseBodySegments(
  body: string,
  knownFootnotes: Set<number>,
  shortIdByTitle: Map<string, string>,
): BodySegment[] {
  const out: BodySegment[] = [];
  let last = 0;
  for (const m of body.matchAll(MARKUP_RE)) {
    const start = m.index!;
    if (start > last) out.push({ kind: "text", text: body.slice(last, start) });
    last = start + m[0].length;

    const [, footnoteNum, wikiTarget, wikiLabel] = m;
    if (footnoteNum != null) {
      const num = Number(footnoteNum);
      out.push({ kind: "footnote", num, known: knownFootnotes.has(num) });
      continue;
    }
    const target = normalizeTarget(wikiTarget ?? "");
    const label = (wikiLabel ?? "").trim() || target;
    const shortId = shortIdByTitle.get(target);
    out.push(shortId ? { kind: "link", label, shortId } : { kind: "deadLink", label, target });
  }
  if (last < body.length) out.push({ kind: "text", text: body.slice(last) });
  return out;
}

export interface FootnoteAudit {
  /** 本文が指しているのに対応する出典が無い番号 */
  missingSources: number[];
  /** 出典はあるのに本文のどこからも参照されていない番号 */
  unreferenced: number[];
  /** `[[3]]` のように数字だけの記事間リンク。脚注 `^[3]` の書き間違いと思われる */
  numericWikiLinks: number[];
  /** 解決できない記事間リンクの宛先 */
  brokenLinks: string[];
}

/** 1 件でも指摘があるか。警告ブロックを出すかどうかの判定を 1 箇所にする */
export function hasFootnoteIssues(audit: FootnoteAudit): boolean {
  return (
    audit.missingSources.length > 0 ||
    audit.unreferenced.length > 0 ||
    audit.numericWikiLinks.length > 0 ||
    audit.brokenLinks.length > 0
  );
}

/**
 * 本文と出典・記事間リンクの対応を突き合わせる。
 *
 * 「未参照の出典」は 2 つの場合を分ける必要がある:
 *
 * - **本文に脚注が 1 つも無い記事** — 記事全体がその出典から来ている形
 *   (quote 記事はほぼこれ。実測で quote 67 本中 57 本)。正常なので出さない
 * - 脚注を使っているのに一部の出典だけ引用されていない — 本物の取りこぼし
 *
 * 出典に番号が振られていないもの (`sourceNo` が null) は akashic 側で足した
 * 紐づけなので、本文から参照されていなくても異常ではない。
 */
export function auditFootnotes(
  body: string,
  sourceNumbers: (number | null)[],
  knownTitles?: Set<string>,
): FootnoteAudit {
  const numbered = sourceNumbers.filter((n): n is number => n != null);
  const known = new Set(numbered);
  const refs = footnoteRefsInBody(body);
  const refSet = new Set(refs);

  const targets = wikiLinkTargetsInBody(body);
  // `[[3]]` は脚注 `^[3]` の書き間違い。実データで 1 記事 6 箇所あり、
  // その記事の「未参照の出典」の正体がこれだった
  const numericWikiLinks = targets.filter((t) => /^\d+$/.test(t)).map(Number);
  const numericSet = new Set(numericWikiLinks);

  return {
    missingSources: refs.filter((n) => !known.has(n)),
    unreferenced:
      refs.length === 0 && numericWikiLinks.length === 0
        ? []
        : [...new Set(numbered)]
            .filter((n) => !refSet.has(n) && !numericSet.has(n))
            .sort((a, b) => a - b),
    numericWikiLinks,
    brokenLinks: knownTitles
      ? targets.filter((t) => !/^\d+$/.test(t) && !knownTitles.has(t))
      : [],
  };
}

/**
 * 脚注 `^[n]` を含む段落を、読める文にして返す。
 *
 * アセット詳細の「記事での参照」で使う (#41): そのアセットを出典にしている記述が
 * 記事のどこかを、記事を開かずに分かるようにする。段落は空行区切り。
 * 見出し・箇条書き・表の行もそれぞれ 1 段落として扱う (出典は表の中にも付く)。
 *
 * 表示用なので Markdown は軽く剥がすだけ: 脚注マーカー、`[[タイトル|表示]]`、
 * 強調、見出しの `#`、画像、リンクの URL 部分。完全な変換は `render.ts` の仕事
 */
export function paragraphsCiting(body: string, num: number): string[] {
  // `]` が続くので `^[1]` が `^[12]` に当たることはない (先読みは不要。付けると `^[1]12月` を落とす)
  const marker = new RegExp(`\\^\\[${num}\\]`);
  const out: string[] = [];
  // 取り込み直後の CRLF 本文も 1 段落に潰さない
  for (const block of body.split(/\r?\n[ \t]*\r?\n/)) {
    if (!marker.test(block)) continue;
    const text = stripInlineMarkdown(block);
    if (text) out.push(text);
  }
  return out;
}

function stripInlineMarkdown(block: string): string {
  return (
    block
      // 脚注マーカー
      .replace(FOOTNOTE_RE, "")
      // 画像は残しても読めない
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      // [[タイトル|表示]] → 表示 (無ければタイトル)
      .replace(WIKILINK_RE, (_m, target: string, label?: string) => (label ?? "").trim() || normalizeTarget(target))
      // [表示](url) → 表示
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // 見出し・引用・箇条書きの行頭記号
      .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+\.[ \t]+)/gm, "")
      // 強調
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
      .split("\n")
      // 表: 罫線行 (`|---|:--|` のような行) だけ落とし、セル区切りを空白にする
      .filter((line) => !(/^[ \t]*\|?[-:| \t]+\|?[ \t]*$/.test(line) && line.includes("-")))
      .map((line) => line.replace(/^[ \t]*\|/, "").replace(/\|[ \t]*$/, "").replace(/[ \t]*\|[ \t]*/g, " ").trim())
      .filter((line) => line !== "")
      .join("\n")
  );
}
