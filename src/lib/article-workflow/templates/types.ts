/**
 * 記事テンプレートの定義 (#169 / #170)。
 *
 * テンプレートは「ドシエの素材 → 記事」の組み立て方で、`ArticleTemplate` (Prisma enum) ごとに
 * 1 つ。DB に触らない純粋関数だけを持ち、domain 層 (`src/lib/domain/article-generate.ts`) が
 * 素材の読み込み・保存・追記を共通に受け持つ。
 */

import type { ArticleTemplate, ArticleType } from "@prisma/client";
import type { AppendLayout } from "@/lib/meetgreet/append";
import type { ArticleAssetInput, RenderedArticle } from "../render";

/** 器を持たないテンプレートの組み立てに渡す、ドシエの素材 */
export interface DossierRenderInput {
  dossier: { id: string; title: string; updatedAt: string; itemCount: number };
  /** asset_ref のアイテム (機密で落としたものは含まない。同じアセットは 1 件にまとめ済み) */
  assets: ArticleAssetInput[];
  /** external_link の X の URL (ドシエの並び順) */
  reports: string[];
  /** external_link の TikTok の URL (video ID 付きに解決済み) */
  tiktoks: string[];
  /** ドシエの「サムネ」(external_image) の URL */
  thumbnailUrl: string | null;
  /** published_at / synced_at に入れる JST の今日 */
  today: string;
}

/**
 * AI が書いた下書き (#171)。テンプレートが必要な項目だけ使う (スナップは title / date を使わない)。
 * プレビューが返し、画面が保存に渡す (保存で生成し直すと別の文になり指紋が合わないため)
 */
export interface AiDraft {
  body: string;
  tags: string[];
  /** ドシエタイトルと違うタイトルを提案するとき (quote_situational だけ使う) */
  title: string | null;
  /** "YYYY-MM-DD" (outing だけ使う) */
  date: string | null;
  dateDisplay: string | null;
}

/** プロンプトに入れる、素材以外の文脈 */
export interface AiContext {
  /** 既存記事のタイトル (wikilink はこの中にだけ張らせる) */
  existingTitles: string[];
  /** 既存記事のタグ (使用頻度順)。tags はここから選ばせる */
  tagVocabulary: string[];
}

export interface AiPrompt {
  /** 毎回同じ部分 (鉄則・見本・語彙)。prompt caching の対象 */
  system: string;
  /** 素材 (毎回変わる) */
  user: string;
}

export interface ArticleTemplateDef {
  key: ArticleTemplate;
  /** 記事の type (= path の先頭ディレクトリ) */
  articleType: ArticleType;
  /** 本文を AI が書くか (#171)。true のテンプレートは新規作成を draft で保存する */
  needsAi: boolean;
  /** 追記の章の置き方 (`planAppend`) */
  appendLayout: AppendLayout;
  /**
   * ドシエの素材から記事を組み立てる。
   * **器 (MeetGreet / Live) を持つテンプレートは null** で、器側の関数
   * (`buildMeetGreetArticle` 等) が開催日などの構造化メタと合わせて組む。
   *
   * `needsAi` のテンプレートは `draft` を受け取る: AI の下書きなら差し込み、
   * **null なら AI が使えなかった**ので本文はプレースホルダ (骨組みだけ。人が後で書く)
   */
  render: ((input: DossierRenderInput, draft?: AiDraft | null) => RenderedArticle) | null;
  /** `needsAi` のテンプレートだけ。素材からプロンプトを組む (純粋関数) */
  prompt?: (input: DossierRenderInput, context: AiContext) => AiPrompt;
}
