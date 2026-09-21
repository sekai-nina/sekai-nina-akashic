/**
 * 画面 (クライアント部品) とドメイン層で共有する型。
 *
 * **重い依存 (sharp / R2 / Drive / Prisma Client の値) を持ち込まない。**
 * クライアント部品がドメイン層から型を import すると、型は消えてもモジュール解決が
 * 走って sharp まで引きずり込み、ビルドが落ちる。共有する形はここに置く。
 */

import type { AssetKind } from "@prisma/client";
import type { AiDraft } from "@/lib/article-workflow/templates/types";
import type { ArticleAiStatus } from "@/lib/domain/dossier-article";

/**
 * 「足さない」と決めたものの種別 (#134)。
 * `append.ts` ではなくここに置く (クライアント部品が使うため。冒頭の注意を参照)
 */
export type ExclusionKind = "quote" | "report" | "tiktok" | "talk" | "blogImage";

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
  /** 足されるものの一覧。チェックを外したものは「今後足さない」として覚える (#134) */
  additions: { key: string; kind: ExclusionKind; label: string }[];
  /** 今「足さない」と覚えているもの。戻せるように見せる (#134) */
  excluded: { key: string; label: string }[];
  /** 何も増えない */
  empty: boolean;
  /** 既存記事がある場合の shortId */
  shortId: string | null;
  /** 本文を AI が書くテンプレートの新規作成のとき (#171)。それ以外は null */
  ai: ArticleAiStatus | null;
  /** 保存に渡す下書き。AI が使えなかった (骨組み) なら null */
  aiDraft: AiDraft | null;
}
