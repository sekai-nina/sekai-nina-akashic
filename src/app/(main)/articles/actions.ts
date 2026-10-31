"use server";

import { revalidatePath } from "next/cache";
import { redirect, RedirectType } from "next/navigation";
import { requireRole } from "@/lib/auth/require-role";
import {
  addAssetToArticle,
  applyArticleSource,
  ArticleDossierError,
  ensureArticleDossier,
  removeArticleSource,
  setArticleSiteVisibility,
} from "@/lib/domain/articles";
import { GithubApiError } from "@/lib/github/client";
import { invalidateDossiers } from "@/lib/cache";
import { ARTICLE_REVIEW_LABELS, toTextType } from "@/lib/utils";

/**
 * 出典 (ArticleSource) の紐づけ・解除・反映。記事本文の編集は `[shortId]/edit/actions.ts`。
 */

/**
 * アセット (と抜粋) を記事に紐づける。status は pending 固定。
 * 記事本文への反映は別工程 (AI / 人) が行い、そこで applied に遷移させる。
 */
export async function addAssetToArticleAction(
  articleId: string,
  assetId: string,
  options?: {
    label?: string;
    excerpt?: string;
    /** クライアント由来なので信用せず、ここで enum に絞り込む */
    excerptType?: string;
    excerptStart?: number;
    excerptEnd?: number;
  },
) {
  const user = await requireRole(["admin", "member"]);
  const created = await addAssetToArticle(
    {
      articleId,
      assetId,
      label: options?.label,
      excerpt: options?.excerpt,
      excerptType: toTextType(options?.excerptType),
      excerptStart: options?.excerptStart,
      excerptEnd: options?.excerptEnd,
      actor: { id: user.id },
    },
    user.clearance,
  );
  revalidatePath("/articles");
  return { id: created.id, articleId: created.articleId };
}

export async function removeArticleSourceAction(id: string, shortId: string) {
  const user = await requireRole(["admin", "member"]);
  await removeArticleSource(id, user.clearance);
  revalidatePath("/articles");
  revalidatePath(`/articles/${shortId}`);
}

export type ApplyArticleSourceState = { error: string };

/**
 * 紐づけ (pending) を「本文に反映済み」にする。**公開を決める操作** (詳細は `applyArticleSource`)。
 *
 * 画面は人間が押すので classification の上限は掛けない (confidential 以上も可。API キー経路は
 * internal 以下のみ)。楽観ロックの `updatedAt` はページ描画時の値をそのまま渡す。
 * 失敗は throw せず state で返す (衝突は「再読み込み」を促す文言にする)。成功したら
 * `?applied=<sourceNo>` を付けて詳細へ redirect し、ページ側が「本文に ^[n] を書く」バナーを出す
 * (revalidate で行が applied に描き直されるとボタン側の表示は消えるため、URL で運ぶ)。
 */
export async function applyArticleSourceAction(
  sourceId: string,
  shortId: string,
  updatedAt: string,
): Promise<ApplyArticleSourceState> {
  const user = await requireRole(["admin", "member"]);
  const expected = new Date(updatedAt);
  if (Number.isNaN(expected.getTime())) return { error: "ページが古いか壊れています。再読み込みしてください" };

  const result = await applyArticleSource(
    { shortId, sourceId, expectedUpdatedAt: expected, actor: { id: user.id } },
    user.clearance,
  );
  if (!result.ok) {
    const messages: Record<typeof result.reason, string> = {
      not_found: "紐づけが見つかりません (削除されたか、クリアランスが足りません)",
      not_pending: "この紐づけは既に反映済みです",
      asset_missing: "元のアセットが削除されているため反映できません",
      above_limit: "この経路では反映できません",
      conflict: "別の保存か取り込みが先に入りました。再読み込みしてください",
    };
    return { error: messages[result.reason] };
  }

  // 一覧・詳細・push 画面の「未 push」表示をまとめて更新する (監査ログは domain が書く)
  revalidatePath("/articles", "layout");
  redirect(`/articles/${shortId}?applied=${result.sourceNo}`, RedirectType.replace);
}

export type EnsureArticleDossierResult =
  | { ok: true; dossierId: string; created: boolean }
  | { ok: false; error: string };

/**
 * 記事の素材ドシエを作ってリンクする (#41)。既にあればそれを返す。
 * クリップを「この記事に足す」ときの移動先になる。
 *
 * 入力起因の失敗は state で返す (本番の Server Action は throw した文言を伏せるので、
 * 画面に出したい文言は返り値で運ぶ)。
 */
export async function ensureArticleDossierAction(
  articleId: string,
  shortId: string
): Promise<EnsureArticleDossierResult> {
  const user = await requireRole(["admin", "member"]);
  try {
    const result = await ensureArticleDossier(user, articleId);
    if (result.created) {
      invalidateDossiers();
      revalidatePath("/dossiers");
      revalidatePath(`/articles/${shortId}`);
    }
    return { ok: true, ...result };
  } catch (e) {
    if (e instanceof ArticleDossierError) return { ok: false, error: e.message };
    throw e;
  }
}

export type SiteVisibilityState = { ok: true; message: string } | { ok: false; error: string } | null;

/**
 * 記事をサイトから隠す / サイトに公開する (#327)。その 1 本だけをすぐ push する。
 * **admin のみ** (push と同じ。公開リポジトリへの書き込み)
 */
export async function setSiteVisibilityAction(shortId: string, hidden: boolean): Promise<SiteVisibilityState> {
  const user = await requireRole(["admin"]);
  try {
    const r = await setArticleSiteVisibility(shortId, hidden, { id: user.id });
    revalidatePath("/articles", "layout");
    if (!r.ok) {
      return {
        ok: false,
        error:
          r.reason === "needs_review"
            ? `${ARTICLE_REVIEW_LABELS.needsReview}の記事は公開できません。編集画面で「${ARTICLE_REVIEW_LABELS.markReviewed}」を付けてから公開してください`
            : "記事が見つかりません",
      };
    }
    const p = r.push;
    if (p.conflicts) {
      return { ok: false, error: "GitHub 側と衝突したため push できませんでした（設定は元に戻しました）。push 画面で確認してください" };
    }
    if (p.blocked) {
      return { ok: false, error: "公開以外の出典があるため push できませんでした（設定は元に戻しました）。push 画面で確認してください" };
    }
    if (p.dbError) return { ok: false, error: `GitHub には載りましたが、DB の更新に失敗しました: ${p.dbError}` };
    return { ok: true, message: hidden ? "サイトから隠しました（数分でサイトに反映されます）" : "サイトに公開しました（数分でサイトに反映されます）" };
  } catch (e) {
    revalidatePath("/articles", "layout");
    if (e instanceof GithubApiError) return { ok: false, error: `push に失敗しました（設定は元に戻しました）: ${e.message}` };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
