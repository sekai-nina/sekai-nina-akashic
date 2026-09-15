"use server";

import { revalidatePath } from "next/cache";
import { redirect, RedirectType } from "next/navigation";
import { requireRole } from "@/lib/auth/require-role";
import { withClearance } from "@/lib/db";
import { getArticleTitleIndex, updateArticle } from "@/lib/domain/articles";
import { BODY_MAX_LENGTH, normalizeBody, parseArticleEditForm, type ArticleEditField } from "@/lib/articles/edit";
import { auditFootnotes, type FootnoteAudit } from "@/lib/articles/footnotes";
import { renderArticleBody } from "@/lib/articles/render";

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

  const result = await updateArticle(shortId, expected, parsed.values, { id: user.id });
  if (!result.ok) {
    return {
      error:
        result.reason === "conflict"
          ? "別の保存か取り込みが先に入りました。内容を控えて再読み込みしてください"
          : "記事が見つかりません",
    };
  }

  // 監査ログ (article.update) は domain が書く。一覧・詳細・push 画面の「未 push」表示を
  // まとめて更新する (配下を丸ごと)
  if (result.changed.length) revalidatePath("/articles", "layout");

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
export async function previewArticleAction(shortId: string, body: string): Promise<ArticlePreview> {
  const user = await requireRole(["admin", "member"]);
  const normalized = normalizeBody(body);
  if (normalized.length > BODY_MAX_LENGTH) throw new Error(`本文が長すぎます (${BODY_MAX_LENGTH} 文字まで)`);
  const [titleIndex, sources] = await Promise.all([
    getArticleTitleIndex(),
    withClearance(user.clearance, (tx) =>
      tx.articleSource.findMany({ where: { article: { shortId } }, select: { sourceNo: true } }),
    ),
  ]);
  const html = await renderArticleBody(normalized, { wikilinks: titleIndex });
  const audit = auditFootnotes(
    normalized,
    sources.map((s) => s.sourceNo),
    new Set(titleIndex.keys()),
  );
  return { html, audit };
}
