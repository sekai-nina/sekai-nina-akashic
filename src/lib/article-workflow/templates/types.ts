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

export interface ArticleTemplateDef {
  key: ArticleTemplate;
  /** 記事の type (= path の先頭ディレクトリ) */
  articleType: ArticleType;
  /** 本文を AI が書くか (#171 から)。true のテンプレートは新規作成を draft で保存する */
  needsAi: boolean;
  /** 追記の章の置き方 (`planAppend`) */
  appendLayout: AppendLayout;
  /**
   * ドシエの素材から記事を組み立てる。
   * **器 (MeetGreet / Live) を持つテンプレートは null** で、器側の関数
   * (`buildMeetGreetArticle` 等) が開催日などの構造化メタと合わせて組む
   */
  render: ((input: DossierRenderInput) => RenderedArticle) | null;
}
