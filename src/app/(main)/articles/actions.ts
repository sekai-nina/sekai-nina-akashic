"use server";

import { revalidatePath } from "next/cache";
import { redirect, RedirectType } from "next/navigation";
import { requireRole } from "@/lib/auth/require-role";
import { addAssetToArticle, applyArticleSource, removeArticleSource } from "@/lib/domain/articles";
import { toTextType } from "@/lib/utils";

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
    },
    user.clearance,
  );
  revalidatePath("/articles");
  return created;
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
