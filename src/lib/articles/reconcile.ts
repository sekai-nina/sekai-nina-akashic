import { ArticleSourceStatus, type TextType } from "@prisma/client";

import type { ArticleSourceRow } from "./frontmatter";

/**
 * 再取り込みで DB の出典行 (非 pending) をファイル由来の行に置き換えるときの突き合わせ。
 *
 * 取り込み (`pnpm cli:import-articles`) は frontmatter 由来の出典を `deleteMany(status != pending)`
 * + `createMany` で全置換する。pending → applied (`applyArticleSource`) が入ると、この全置換で
 * 2 つのものが消える:
 *
 * 1. **抜粋 (`excerpt` / `note`)。** applied にして push した行は次の取り込みで frontmatter から
 *    再作成されるが、抜粋は Markdown に無い。→ 既存行から新しい行に写す
 * 2. **未 push の applied 行そのもの。** applied にしたが push する前に上流が変わると、
 *    その記事は preserve されず全置換に入り、ファイルに無い行は消える。PR3 より前は同じ行が
 *    pending のまま残っていた (取り込みは pending を触らない)。→ 削除せず pending に戻す
 *
 * 照合は **`assetId` + `sourceNo`**。同一アセットを複数回紐づけられる (`@@unique` を持たない)
 * ので `assetId` だけでは決まらない。`sourceNo` の無い行 (url だけの出典) は、そのアセットが
 * 既存側でも今回側でも 1 行ずつしか無いときだけ対応づける。取り違えると別の脚注に別の抜粋が
 * 付くので、迷ったら対応づけない (消える方がまし)。
 */

/** 引き継ぐ列。DB の ArticleSource と同じ形 */
export interface ExcerptFields {
  excerpt: string;
  excerptType: TextType | null;
  excerptStart: number | null;
  excerptEnd: number | null;
  note: string;
}

/** DB にある非 pending の行のうち、突き合わせに要る列 */
export interface ExistingSourceRow extends ExcerptFields {
  id: string;
  assetId: string | null;
  sourceNo: number | null;
  status: ArticleSourceStatus;
  originalRef: string | null;
}

export interface ReconciledSources<T> {
  /** `createMany` に渡す行。対応する既存行に抜粋があれば写してある */
  rows: (T & Partial<ExcerptFields>)[];
  /** 今回のファイルに対応する行が無かった既存行 */
  unmatched: ExistingSourceRow[];
}

const hasExcerpt = (row: ExcerptFields) =>
  row.excerpt !== "" || row.note !== "" || row.excerptStart != null || row.excerptEnd != null;

const pickExcerpt = (row: ExcerptFields): ExcerptFields => ({
  excerpt: row.excerpt,
  excerptType: row.excerptType,
  excerptStart: row.excerptStart,
  excerptEnd: row.excerptEnd,
  note: row.note,
});

// cuid に "/" は含まれないので区切りに使える
const key = (assetId: string, sourceNo: number) => `${assetId}/${sourceNo}`;

/**
 * `wanted` (今回 frontmatter から作る行) と `existing` (DB の非 pending 行) を突き合わせる。
 * 対応した既存行に抜粋があれば `wanted` 側に写し、対応しなかった既存行を `unmatched` で返す。
 */
export function reconcileSources<T extends Pick<ArticleSourceRow, "assetId" | "sourceNo">>(
  existing: readonly ExistingSourceRow[],
  wanted: readonly T[],
): ReconciledSources<T> {
  const byKey = new Map<string, ExistingSourceRow>();
  const byAsset = new Map<string, ExistingSourceRow[]>();
  for (const row of existing) {
    if (row.assetId == null) continue;
    if (row.sourceNo != null) byKey.set(key(row.assetId, row.sourceNo), row);
    const list = byAsset.get(row.assetId);
    if (list) list.push(row);
    else byAsset.set(row.assetId, [row]);
  }
  const wantedCountByAsset = new Map<string, number>();
  for (const w of wanted) {
    if (w.assetId != null) wantedCountByAsset.set(w.assetId, (wantedCountByAsset.get(w.assetId) ?? 0) + 1);
  }

  const used = new Set<ExistingSourceRow>();
  const rows = wanted.map((w) => {
    if (w.assetId == null) return w;
    let match: ExistingSourceRow | undefined;
    if (w.sourceNo != null) {
      match = byKey.get(key(w.assetId, w.sourceNo));
    } else {
      const candidates = byAsset.get(w.assetId) ?? [];
      // 既存側も今回側もそのアセットが 1 行だけのときに限る
      if (candidates.length === 1 && wantedCountByAsset.get(w.assetId) === 1) match = candidates[0];
    }
    if (!match || used.has(match)) return w;
    used.add(match);
    return hasExcerpt(match) ? { ...w, ...pickExcerpt(match) } : w;
  });
  return { rows, unmatched: existing.filter((row) => !used.has(row)) };
}

/**
 * 対応する行がファイルに無かった既存行のうち、**akashic で applied にしたが上流には無い**もの。
 * 削除せず pending に戻す対象。
 *
 * 目印は `applied && originalRef == null && assetId != null`。frontmatter 由来の applied 行は
 * push で `ref` が書き出され、次の取り込みで `originalRef` が入る (`toArticleSourceRow`) ので、
 * push → 取り込みを一周した行はここに該当しない。akashic で apply したばかりの行は元ファイルに
 * 無いので `originalRef` が null のまま。
 *
 * ref の無い url / label 照合の行 (push 前) も同じ形になるが、それが unmatched になるのは
 * 上流がその出典を消したときで、pending として残しても害は無い (取り込みの出力に出す)。
 */
export function demotableSources(unmatched: readonly ExistingSourceRow[]): ExistingSourceRow[] {
  return unmatched.filter(
    (row) => row.status === ArticleSourceStatus.applied && row.originalRef == null && row.assetId != null,
  );
}
