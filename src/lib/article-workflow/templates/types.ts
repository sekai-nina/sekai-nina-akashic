/**
 * 記事テンプレートの定義 (#169 / #170)。
 *
 * テンプレートは「ドシエの素材 → 記事」の組み立て方で、`ArticleTemplate` (Prisma enum) ごとに
 * 1 つ。DB に触らない純粋関数だけを持ち、domain 層 (`src/lib/domain/article-generate.ts`) が
 * 素材の読み込み・保存・追記を共通に受け持つ。
 */

import type { ArticleTemplate, ArticleType } from "@prisma/client";
import * as z from "zod";
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
  /**
   * 場所候補 (`DossierPlaceCandidate`、ドシエの並び順)。おでかけ記事の `locations` になる。
   * `placeId` があれば聖地に昇格済み (frontmatter は `place_id` だけ)、無ければ座標をインラインで持つ
   */
  places: DossierPlace[];
  /** published_at / synced_at に入れる JST の今日 */
  today: string;
}

export interface DossierPlace {
  name: string;
  placeId: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  googleMapsUrl: string | null;
  note: string;
}

/**
 * AI が書いた下書き (#171)。テンプレートが必要な項目だけ使う (スナップは title / date を使わない)。
 * プレビューが返し、画面が保存に渡す (保存で生成し直すと別の文になり指紋が合わないため)。
 *
 * **この zod スキーマが唯一の定義。** Claude の Structured Output (`zodOutputFormat`)、
 * REST / Server Action の入力検証、TS の型 (`AiDraft`) がすべてここから出る。
 * 上限は記事編集と同じ桁 (スナップは数百字なので十分)。生成側は `clampAiDraft` で収める
 */
export const AiDraftSchema = z
  .object({
    body: z.string().max(20_000),
    tags: z.array(z.string().max(100)).max(10),
    /** ドシエタイトルと違うタイトルを提案するとき (quote_situational が使う) */
    title: z.string().max(200).nullable(),
    /** "YYYY-MM-DD" (outing / quote_situational が使う) */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    dateDisplay: z.string().max(100).nullable(),
  })
  .strict();

export type AiDraft = z.infer<typeof AiDraftSchema>;

/** 暦に実在する "YYYY-MM-DD" か (2025-13-45 を通さない。`createArticle` が後で弾いて払った生成を捨てないように) */
function isRealDate(value: string): boolean {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** 制御文字を除く (タイトルは記事の path と frontmatter に出る。`createArticle` と同じ扱い) */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** モデルの返答を上限に収め、path になるタイトルを正規化する (プレビューで通ったものが保存で弾かれないように) */
export function clampAiDraft(raw: {
  body: string;
  tags: string[];
  title: string | null;
  date: string | null;
  dateDisplay: string | null;
}): AiDraft {
  const title = raw.title?.normalize("NFC").replace(CONTROL_CHARS, "").trim().slice(0, 200) || null;
  return {
    body: raw.body.slice(0, 20_000),
    tags: raw.tags.map((t) => t.trim().slice(0, 100)).filter((t) => t.length > 0).slice(0, 10),
    title,
    date: raw.date && isRealDate(raw.date) ? raw.date : null,
    dateDisplay: raw.dateDisplay ? raw.dateDisplay.trim().slice(0, 100) || null : null,
  };
}

/** プロンプトに入れる、素材以外の文脈 */
export interface AiContext {
  /** 既存記事のタイトル (wikilink はこの中にだけ張らせる。下書きは除く) */
  existingTitles: string[];
  /** 既存記事のタグ (使用頻度順)。tags はここから選ばせる */
  tagVocabulary: string[];
}

export interface AiPrompt {
  /**
   * 毎回同じ部分。**前から順にキャッシュの区切りにする** (`cache_control`)。
   * 鉄則・見本 (滅多に変わらない) と語彙 (記事を保存すると変わる) を分けておくと、
   * 語彙が変わっても前半のキャッシュは残る
   */
  system: string[];
  /** 素材 (毎回変わる) */
  user: string;
  /** 素材に入れた出典の数 (本文・抜粋・キャプションのどれかがあるもの) */
  included: number;
  /** 本文を切った出典の数 */
  truncated: number;
}

export interface AiUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** AI の状態 (画面に出す) */
export interface ArticleAiStatus {
  /** generated: 今回書いた / given: 画面から受け取った下書きを使った / unavailable: 使えなかった (骨組みだけ) */
  status: "generated" | "given" | "unavailable";
  model: string | null;
  /** unavailable の理由 (画面に出してよい文言) */
  reason: string | null;
  /** 素材に入れた出典の数 / 本文を切った出典の数 */
  included: number;
  truncated: number;
  usage: AiUsage | null;
  /** 今回の分の費用 (単価表に無ければ null) */
  costUsd: number | null;
}

interface ArticleTemplateBase {
  key: ArticleTemplate;
  /** 記事の type (= path の先頭ディレクトリ) */
  articleType: ArticleType;
  /** 追記の章の置き方 (`planAppend`) */
  appendLayout: AppendLayout;
  /**
   * 追記のたびに frontmatter で作り直す `frontmatterExtra` のキー (ライブの `live:` など、機械が持つブロック)。
   * `dossier` (スナップショット) は常に作り直す。ここに無いキー (`meetgreet:` / `locations`) は
   * 新規作成時のまま (人が直しうるので触らない)
   */
  refreshExtraOnAppend?: string[];
  /**
   * ドシエの素材から記事を組み立てる。
   * **器 (MeetGreet / Live) を持つテンプレートは null** で、器側の関数
   * (`buildMeetGreetArticle` 等) が開催日などの構造化メタと合わせて組む。
   *
   * `needsAi` のテンプレートは `draft` を受け取る: AI の下書きなら差し込み、
   * **null なら AI が使えなかった**ので本文はプレースホルダ (骨組みだけ。人が後で書く)
   */
  render: ((input: DossierRenderInput, draft?: AiDraft | null) => RenderedArticle) | null;
}

/** 本文を AI が書くか (#171)。書くテンプレートは必ずプロンプトを持ち、新規作成を draft で保存する */
export type ArticleTemplateDef = ArticleTemplateBase &
  (
    | { needsAi: true; prompt: (input: DossierRenderInput, context: AiContext) => AiPrompt }
    | { needsAi: false; prompt?: undefined }
  );
