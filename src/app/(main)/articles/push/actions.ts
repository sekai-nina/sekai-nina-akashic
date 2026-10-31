"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ARTICLE_REVIEW_LABELS } from "@/lib/utils";
import { pushDirtyArticles, type PushArticlesResult } from "@/lib/domain/articles";
import { logAudit } from "@/lib/domain/audit";
import { GithubApiError } from "@/lib/github/client";

export type PushActionState =
  | { ok: true; result: PushArticlesResult }
  | { ok: false; error: string };

/**
 * 選んだ dirty な記事を GitHub に 1 コミットで push する (#328)。**admin のみ。**
 * 「内容が同じ」記事 (コミットに載らず未 push の印だけ外す) は画面が `shortIds` に混ぜて送る。
 *
 * 公開リポジトリへの書き込みなので、他の書き込み系 (admin / member) より狭くする。
 * 認可の失敗は他の Server Action と同じく throw (UI は admin にしかボタンを出さない)。
 * GitHub 側の失敗は例外にせず戻り値で返す (画面にそのまま出す)。422 は
 * 「tree を読んでから commit するまでにブランチが進んだ」= 別経路の push と
 * 重なったときなので、読み直して再実行してもらう。
 */
export async function pushArticlesAction(subject: string, shortIds: string[]): Promise<PushActionState> {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");
  if (session.user.role !== "admin") throw new Error("Forbidden");
  // 選んだ記事だけ push する (#328)。空なら何もしない (全部 push に化けさせない)
  const ids = [...new Set(shortIds.filter((id) => typeof id === "string" && /^[0-9A-Za-z]{7}$/.test(id)))];
  if (!ids.length) return { ok: false, error: "push する記事が選ばれていません" };
  // 「AI 書きたて (未確認)」は push させない (#327。画面でも選べない)
  const unreviewed = await prisma.article.findMany({
    where: { shortId: { in: ids }, needsReview: true },
    select: { shortId: true },
  });
  if (unreviewed.length) {
    return {
      ok: false,
      error: `${ARTICLE_REVIEW_LABELS.needsReview}の記事が含まれています。編集画面で「${ARTICLE_REVIEW_LABELS.markReviewed}」を付けてください`,
    };
  }

  try {
    const result = await pushDirtyArticles(subject, { shortIds: ids });
    if (result.commit) {
      await logAudit({
        actorId: session.user.id,
        action: "article.push",
        targetType: "github_commit",
        targetId: result.commit.commitSha,
        metadata: {
          url: result.commit.url,
          pushed: result.pushed,
          unchanged: result.unchanged,
          blocked: result.blocked,
          conflicts: result.conflicts,
          dbError: result.dbError,
        },
      });
    }
    // 一覧・詳細・この画面の「未 push」表示をまとめて更新する (配下を丸ごと)
    revalidatePath("/articles", "layout");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof GithubApiError) {
      const hint =
        e.status === 422
          ? " — 読んだ時点からブランチが進んでいます。ページを再読み込みして、衝突が無ければもう一度 push してください"
          : e.status === 401 || e.status === 403
            ? " — ARTICLES_GITHUB_TOKEN が無効か、リポジトリへの書き込み権限がありません"
            : "";
      return { ok: false, error: `${e.message}${hint}` };
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
