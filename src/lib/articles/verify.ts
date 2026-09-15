import { canonicalJson } from "./changes";
import { parseArticle, parseFrontmatterDate, toArticleColumns } from "./frontmatter";

/**
 * DB から組み立てた記事 Markdown と、リポジトリの実ファイルの突き合わせ。
 *
 * `pnpm cli:verify-article-push` の中身。CLI に直接書くとテストが付かず、
 * 「日付が {} に潰れて差分を見逃す」類のミスに気づけないので純粋関数として切り出す。
 */

export type Verdict = "identical" | "normalized" | "ref_added" | "changed";

export const VERDICT_LABELS: Record<Verdict, string> = {
  identical: "一致",
  normalized: "正規化のみ",
  ref_added: "ref 追加",
  changed: "値の差分",
};

export interface Comparison {
  verdict: Verdict;
  /** 何が違うかの説明。changed のときは必ず 1 行以上入る */
  notes: string[];
}

/** 値の比較キー。Date は ISO で比べる (canonicalJson が Date を扱えるのに依存) */
const key = (v: unknown) => JSON.stringify(canonicalJson(v));

/**
 * 元ファイルの frontmatter のうち、`toArticleColumns` が黙って捨てる値を拾う。
 *
 * 両辺を同じ lossy な parse に通して比べるので、parse が落とす値は両側で消えて
 * 「一致」に見える。ここで元ファイル側の生の値とカラムを突き合わせて補う。
 */
function lossyParseNotes(raw: ReturnType<typeof parseArticle>, cols: ReturnType<typeof toArticleColumns>): string[] {
  const fm = raw.frontmatter;
  const notes: string[] = [];
  if (fm.type != null && cols.type == null) notes.push(`type: ${String(fm.type)} は ArticleType に無く push で消える`);
  for (const [k, col] of [
    ["date", cols.date],
    ["published_at", cols.publishedAt],
    ["updated_at", cols.articleUpdatedAt],
  ] as const) {
    if (fm[k] != null && fm[k] !== "" && col == null) notes.push(`${k}: ${String(fm[k])} は日付として読めず push で消える`);
  }
  if (fm.tags != null && !Array.isArray(fm.tags)) notes.push("tags: 配列でないので push で消える");
  if (fm.source != null && !Array.isArray(fm.source)) notes.push("source: 配列でないので push で消える");
  return notes;
}

/**
 * 値レベルの比較。
 *
 * - バイト単位で同じなら identical
 * - カラム・本文・source が同じで、source の差が「ref が新たに生えた」だけなら ref_added
 *   (url / label で照合して applied になった行に ref が補完される。合意済み: #74)
 * - 値は同じでバイトが違うなら normalized (引用符・キー順・日付のゼロ埋め等)
 * - それ以外は changed。**取りこぼしの疑いがあるので push してはいけない**
 */
export function compareArticle(fileRaw: string, generated: string, path: string): Comparison {
  if (fileRaw === generated) return { verdict: "identical", notes: [] };

  const rawA = parseArticle(fileRaw);
  const a = toArticleColumns(rawA, path);
  const b = toArticleColumns(parseArticle(generated), path);
  const notes = lossyParseNotes(rawA, a);

  const { sources: aSources, ...aCols } = a;
  const { sources: bSources, ...bCols } = b;
  for (const k of Object.keys(aCols) as (keyof typeof aCols)[]) {
    const av = key(aCols[k]);
    const bv = key(bCols[k]);
    if (av !== bv) notes.push(`${k}: ${av} → ${bv}`);
  }

  let refsAdded = 0;
  if (aSources.length !== bSources.length) {
    notes.push(`source の件数: ${aSources.length} → ${bSources.length}`);
  } else {
    aSources.forEach((s, i) => {
      const t = bSources[i];
      for (const k of ["id", "url", "label"] as const) {
        if (s[k] !== t[k]) notes.push(`source[${i}].${k}: ${JSON.stringify(s[k])} → ${JSON.stringify(t[k])}`);
      }
      // 日付は値で比べる (`2026-01-8` → `2026-01-08` のゼロ埋めは正規化の範囲)
      const sd = parseFrontmatterDate(s.date)?.getTime() ?? null;
      const td = parseFrontmatterDate(t.date)?.getTime() ?? null;
      if (sd !== td) notes.push(`source[${i}].date: ${JSON.stringify(s.date)} → ${JSON.stringify(t.date)}`);
      if (s.ref !== t.ref) {
        if (s.ref == null && t.ref != null) refsAdded++;
        else notes.push(`source[${i}].ref: ${JSON.stringify(s.ref)} → ${JSON.stringify(t.ref)}`);
      }
    });
  }

  // ref の補完は changed のときも原因調査の材料になるので必ず載せる
  if (refsAdded) notes.push(`ref を ${refsAdded} 件補完`);
  if (notes.length > (refsAdded ? 1 : 0)) return { verdict: "changed", notes };
  if (refsAdded) return { verdict: "ref_added", notes };
  return { verdict: "normalized", notes: [] };
}

/**
 * 最小限の行差分 (LCS)。`-` が元ファイル、`+` が生成側。
 * unified 形式ではない (hunk ヘッダも文脈行も無い)。記事は高々数百行なので O(n·m) で足りる
 */
export function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out.join("\n");
}
