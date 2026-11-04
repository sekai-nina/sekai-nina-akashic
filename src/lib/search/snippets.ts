/** 抜粋の合計の上限。頻出語 (「の」等) で本文がまるごと抜粋にならないよう切る */
export const MAX_SNIPPET_CHARS = 800;

/**
 * 一致箇所の前後を切り出す。近い一致は 1 つの抜粋にまとめ、離れた一致は別の抜粋にする。
 * matchCount は抜粋の上限で切った分も含めた、本文全体の一致数。
 */
export function buildSnippets(
  text: string,
  terms: string[],
  contextLen = 80
): { snippets: string[]; matchCount: number } {
  const head = () => text.slice(0, contextLen * 2) + (text.length > contextLen * 2 ? "…" : "");
  if (terms.length === 0) return { snippets: [head()], matchCount: 0 };

  const lower = text.toLowerCase();

  const positions: Array<{ start: number; end: number }> = [];
  for (const term of terms) {
    const termLower = term.toLowerCase();
    let cursor = 0;
    while (cursor < lower.length) {
      const idx = lower.indexOf(termLower, cursor);
      if (idx === -1) break;
      positions.push({ start: idx, end: idx + term.length });
      cursor = idx + term.length;
    }
  }

  if (positions.length === 0) return { snippets: [head()], matchCount: 0 };

  positions.sort((a, b) => a.start - b.start);

  const ranges: Array<{ start: number; end: number; firstMatchEnd: number }> = [];
  for (const pos of positions) {
    const ctxStart = Math.max(0, pos.start - contextLen);
    const ctxEnd = Math.min(text.length, pos.end + contextLen);
    const last = ranges[ranges.length - 1];
    if (last && ctxStart <= last.end) {
      last.end = Math.max(last.end, ctxEnd);
    } else {
      ranges.push({ start: ctxStart, end: ctxEnd, firstMatchEnd: pos.end });
    }
  }

  const snippets: string[] = [];
  let remaining = MAX_SNIPPET_CHARS;
  for (const range of ranges) {
    // 一致の手前で上限に届く範囲は、一致の無い抜粋になるので出さない
    if (range.start + remaining < range.firstMatchEnd) break;
    const end = Math.min(range.end, range.start + remaining);
    snippets.push(
      (range.start > 0 ? "…" : "") + text.slice(range.start, end) + (end < text.length ? "…" : "")
    );
    remaining -= end - range.start;
  }

  return { snippets, matchCount: positions.length };
}
