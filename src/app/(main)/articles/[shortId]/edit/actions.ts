"use server";

import { revalidatePath } from "next/cache";
import { redirect, RedirectType } from "next/navigation";
import { requireRole } from "@/lib/auth/require-role";
import { withClearance } from "@/lib/db";
import {
  checkReservedArticleSources,
  markArticleReviewed,
  getArticleByShortId,
  getArticleTitleIndex,
  saveArticleRelated,
  saveArticleSourceArticles,
  updateArticle,
} from "@/lib/domain/articles";
import { parseReservedArticleSources } from "@/lib/articles/source-article";
import { saveArticlePlaces } from "@/lib/domain/article-places";
import type { ArticleType } from "@prisma/client";
import {
  BODY_MAX_LENGTH,
  normalizeBody,
  parseArticleEditForm,
  toDateInputValue,
  type ArticleEditField,
} from "@/lib/articles/edit";
import { auditFootnotes, type FootnoteAudit } from "@/lib/articles/footnotes";
import { renderArticleBody } from "@/lib/articles/render";
import { getArticleSourceContent, type ArticleSourceContent } from "@/lib/domain/article-source-content";

/**
 * 記事編集 (`/articles/[shortId]/edit`) の Server Action。出典の操作は `../../actions.ts`。
 */

export type UpdateArticleState = {
  error: string;
  fieldErrors?: Partial<Record<ArticleEditField, string>>;
} | null;

/**
 * 記事の編集を保存する。admin / member のみ。
 *
 * 成功したら詳細へ redirect する (ここでは何も返さない)。失敗は throw せず state で返す
 * (楽観ロックの衝突で入力を消したくない)。タイトルを変えたときは `?renamedFrom=` を付けて
 * 飛び、詳細側で `[[旧タイトル]]` の参照元を数えて警告する (ブロックはしない)。
 *
 * 関連記事 (`related`)・記事出典 (`articleSources`、#320)・聖地 (`placeIds`) は本文・frontmatter の保存の後に、
 * 返ってきた `updatedAt` でこの順に続けて保存する (同じ楽観ロックに乗せる)。後段だけ失敗したら、前段は保存済みであることを添えて返す。
 */
export async function updateArticleAction(
  shortId: string,
  _prev: UpdateArticleState,
  formData: FormData,
): Promise<UpdateArticleState> {
  const user = await requireRole(["admin", "member"]);

  const text = (name: string) => {
    const v = formData.get(name);
    return typeof v === "string" ? v : null;
  };
  // 記事パネルで予約した記事出典 (#320)。形が壊れていたら何も書く前に断る
  const reservedSources = parseReservedArticleSources(text("articleSources"));
  if (!reservedSources) return { error: "フォームが古いか壊れています。再読み込みしてください" };

  const parsed = parseArticleEditForm({
    title: text("title"),
    type: text("type"),
    tags: formData.getAll("tags").filter((t): t is string => typeof t === "string"),
    body: text("body"),
    date: text("date"),
    dateDisplay: text("dateDisplay"),
    dateMode: text("dateMode"),
    publishedAt: text("publishedAt"),
    articleUpdatedAt: text("articleUpdatedAt"),
    draft: formData.get("draft") === "on",
    unlisted: formData.get("unlisted") === "on",
    ongoing: formData.get("ongoing") === "on",
  });
  if (!parsed.ok) return { error: "入力に誤りがあります", fieldErrors: parsed.errors };

  // 楽観ロック用。フォームが読み込んだ時点の updatedAt (ISO)
  const expected = new Date(text("updatedAt") ?? "");
  if (Number.isNaN(expected.getTime())) return { error: "フォームが古いか壊れています。再読み込みしてください" };

  // 記事出典の予約は本文を保存する前に確かめる (後で断ると ^[n] だけが宛先なしで残る)
  const reservedProblem = await checkReservedArticleSources(shortId, reservedSources, user.clearance);
  if (reservedProblem) {
    return {
      error:
        reservedProblem === "number_taken"
          ? "出典の番号が別の出典と重なりました。予約を取り消して、出典に追加し直してください"
          : "出典にできない記事が含まれています (削除された記事か、この記事自身)",
    };
  }

  const result = await updateArticle(shortId, expected, parsed.values, { id: user.id });
  if (!result.ok) {
    return {
      error:
        result.reason === "conflict"
          ? "別の保存か取り込みが先に入りました。内容を控えて再読み込みしてください"
          : "記事が見つかりません",
    };
  }

  // 関連記事 (#319)。本文などの保存で進んだ updatedAt で続けて保存する
  let updatedAt = result.updatedAt;
  let relatedChanged = false;
  if (formData.get("relatedField") === "1") {
    const related = formData.getAll("related").filter((v): v is string => typeof v === "string");
    const saved = await saveArticleRelated(shortId, updatedAt, related, { id: user.id });
    if (!saved.ok) {
      if (result.changed.length) revalidatePath("/articles", "layout");
      const why = saved.reason === "conflict" ? "別の保存か取り込みが先に入りました" : "記事が見つかりません";
      return {
        error: `関連記事を保存できませんでした (${why})。${result.changed.length ? "本文などは保存済みです。" : ""}再読み込みしてください`,
      };
    }
    updatedAt = saved.updatedAt;
    relatedChanged = saved.changed;
  }

  // 記事出典 (#320)。本文 (^[n] 入り) の保存の後に確定する
  let sourcesChanged = false;
  if (reservedSources.length) {
    const saved = await saveArticleSourceArticles(shortId, updatedAt, reservedSources, { id: user.id }, user.clearance);
    if (!saved.ok) {
      if (result.changed.length || relatedChanged) revalidatePath("/articles", "layout");
      const why =
        saved.reason === "conflict"
          ? "別の保存か取り込みが先に入りました"
          : saved.reason === "number_taken"
            ? "出典の番号が別の出典と重なりました"
            : saved.reason === "invalid_article"
              ? "出典にできない記事が含まれています"
              : "記事が見つかりません";
      return {
        error: `出典を保存できませんでした (${why})。${result.changed.length || relatedChanged ? "本文などは保存済みです。" : ""}再読み込みしてください`,
      };
    }
    updatedAt = saved.updatedAt;
    sourcesChanged = saved.changed;
  }

  let placesChanged = false;
  if (formData.get("placesField") === "1") {
    const placeIds = formData.getAll("placeIds").filter((v): v is string => typeof v === "string" && v !== "");
    const saved = await saveArticlePlaces(shortId, updatedAt, placeIds, { id: user.id }, user.clearance);
    if (!saved.ok) {
      if (result.changed.length || relatedChanged || sourcesChanged) revalidatePath("/articles", "layout");
      const why =
        saved.reason === "conflict"
          ? "別の保存か取り込みが先に入りました"
          : saved.reason === "invalid_place"
            ? "選べない聖地が含まれています"
            : "記事が見つかりません";
      return {
        error: `聖地を保存できませんでした (${why})。${result.changed.length || relatedChanged || sourcesChanged ? "本文などは保存済みです。" : ""}再読み込みしてください`,
      };
    }
    placesChanged = saved.changed;
  }

  // 「確認済みにする」(#327)。push の出力に関係しないので dirty は立てない。楽観ロックの連鎖の最後に置く
  let reviewedChanged = false;
  if (formData.get("reviewed") === "1") {
    reviewedChanged = await markArticleReviewed(shortId, { id: user.id });
  }

  // 監査ログ (article.update) は domain が書く。一覧・詳細・push 画面の「未 push」表示を
  // まとめて更新する (配下を丸ごと)
  if (result.changed.length || relatedChanged || sourcesChanged || placesChanged || reviewedChanged) {
    revalidatePath("/articles", "layout");
  }
  if (placesChanged) revalidatePath("/places", "layout");

  const renamed = result.changed.includes("title") ? `?renamedFrom=${encodeURIComponent(result.previousTitle)}` : "";
  redirect(`/articles/${shortId}${renamed}`, RedirectType.replace);
}

export interface ArticlePreview {
  html: string;
  audit: FootnoteAudit;
}

/**
 * 編集中の本文をプレビューする (保存しない)。詳細ページと同じパイプライン
 * (`renderArticleBody` + `auditFootnotes`) なので、保存後の見た目と警告がそのまま出る。
 * 出典の番号は RLS 下で引く (見えない出典は詳細でも出ないので、警告も同じ基準になる)。
 *
 * 読むだけだが、編集ページ専用なので役割も保存と同じに絞る (remark + KaTeX は CPU を食うので、
 * 誰でも任意の Markdown を投げられる経路にしない)。長さの上限も保存と同じ。
 */
/**
 * `reservedSourceNos` は記事パネルで予約した記事出典の番号 (#320)。まだ DB に無いが、
 * 本文の `^[n]` を「宛先なし」と警告しないよう数に入れる
 */
export async function previewArticleAction(
  shortId: string,
  body: string,
  reservedSourceNos: number[] = [],
): Promise<ArticlePreview> {
  const user = await requireRole(["admin", "member"]);
  const normalized = normalizeBody(body);
  if (normalized.length > BODY_MAX_LENGTH) throw new Error(`本文が長すぎます (${BODY_MAX_LENGTH} 文字まで)`);
  const [titleIndex, sources] = await Promise.all([
    getArticleTitleIndex(),
    withClearance(user.clearance, (tx) =>
      tx.articleSource.findMany({ where: { article: { shortId } }, select: { sourceNo: true, url: true } }),
    ),
  ]);
  const html = await renderArticleBody(normalized, {
    wikilinks: titleIndex,
    sourceUrls: sources.map((s) => s.url),
  });
  const audit = auditFootnotes(
    normalized,
    [...sources.map((s) => s.sourceNo), ...reservedSourceNos.filter((n) => Number.isInteger(n))],
    new Set(titleIndex.keys()),
  );
  return { html, audit };
}

/** 編集しながら横で読む出典の中身。見つからなければ null */
export async function getSourceContentAction(shortId: string, sourceId: string): Promise<ArticleSourceContent | null> {
  const user = await requireRole(["admin", "member"]);
  return getArticleSourceContent(user.clearance, shortId, sourceId);
}

export interface ArticlePeek {
  shortId: string;
  title: string;
  type: ArticleType | null;
  /** 記事の日付 (表示用。date_display があればそれ) */
  dateLabel: string | null;
  draft: boolean;
  html: string;
}

/**
 * 記事パネルで別の記事の中身を読む (#320)。詳細ページと同じパイプラインで本文を描く。
 * 見つからなければ null
 */
export async function getArticlePeekAction(targetShortId: string): Promise<ArticlePeek | null> {
  const user = await requireRole(["admin", "member"]);
  const [article, titleIndex] = await Promise.all([
    getArticleByShortId(targetShortId, user.clearance),
    getArticleTitleIndex(),
  ]);
  if (!article) return null;
  const html = await renderArticleBody(article.body, {
    wikilinks: titleIndex,
    sourceUrls: article.sources.map((s) => s.url),
  });
  return {
    shortId: article.shortId,
    title: article.title,
    type: article.type,
    dateLabel: article.dateDisplay || toDateInputValue(article.date) || null,
    draft: article.draft,
    html,
  };
}
