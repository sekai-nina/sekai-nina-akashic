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
    const t = m[1].trim();
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
    const target = (wikiTarget ?? "").trim();
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
