/**
 * 画面 (クライアント部品) とドメイン層で共有する型。
 *
 * **重い依存 (sharp / R2 / Drive / Prisma Client の値) を持ち込まない。**
 * クライアント部品がドメイン層から型を import すると、型は消えてもモジュール解決が
 * 走って sharp まで引きずり込み、ビルドが落ちる。共有する形はここに置く。
 */

import type { AssetKind } from "@prisma/client";

/** スケッチの参照に使えるドシエ内の画像 */
export interface SketchSourceAsset {
  id: string;
  title: string;
  kind: AssetKind;
  thumbnailUrl: string | null;
}

/** 生成した候補 */
export interface SketchCandidate {
  key: string;
  url: string;
}

/** 抜粋の提案 1 件 */
export interface ExcerptProposal {
  text: string;
  /** なぜその範囲を選んだか (画面に出す) */
  reason: string;
  start: number;
  end: number;
}

/** ブログ 1 本ぶんの提案 */
export interface BlogExcerptProposals {
  assetId: string;
  title: string;
  url: string | null;
  proposals: ExcerptProposal[];
}

/** 反映する抜粋の範囲 */
export interface ApplyExcerptInput {
  assetId: string;
  start: number;
  end: number;
}

/** 記事生成の種別 */
export type ArticleMode = "create" | "append";

/** 記事生成のプレビュー (画面が受け取る形) */
export interface ArticlePreview {
  mode: ArticleMode;
  title: string;
  /** 適用後の本文 */
  body: string;
  /** 本文の指紋。保存時に渡して、見せた内容と同じかを確かめる */
  digest: string;
  /** 追記のとき、増えた行の位置 (0 始まり) */
  addedLines: number[];
  /** 追加される出典 */
  newSources: { sourceNo: number; label: string; url: string | null; assetId: string | null }[];
  /** 機密レベルで本文に載せなかったアセットの数 */
  droppedByClearance: number;
  /** 何も増えない */
  empty: boolean;
  /** 既存記事がある場合の shortId */
  shortId: string | null;
}
