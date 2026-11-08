"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/require-role";
import { invalidateAssets } from "@/lib/cache";
import { NinaAuthorConflictError, getClipMedia, setNinaAppearance } from "@/lib/domain/nina-appearance";
import { getAssetRelations } from "@/lib/domain/relations";
import { isNinaAppearance, type NinaAppearance } from "@/lib/nina";

/** アセット詳細の「坂井新奈の出演」を切り替える (#261) */
export async function setAssetNinaAppearance(
  assetId: string,
  status: NinaAppearance
): Promise<{ error?: string }> {
  const user = await requireRole(["admin", "member"]);
  if (!isNinaAppearance(status)) return { error: "不正な状態です" };
  try {
    const result = await setNinaAppearance(assetId, status, user.id, user.clearance);
    if (!result) return { error: "アセットが見つかりません" };
  } catch (err) {
    if (err instanceof NinaAuthorConflictError) return { error: err.message };
    throw err;
  }
  invalidateAssets();
  revalidatePath(`/assets/${assetId}`);
  return {};
}

/** 一度に流す数。1 件ずつ行ロックを取るトランザクションなので、少しだけ並べる */
const BULK_CONCURRENCY = 5;

/**
 * 子アセット (画像・動画) のうち「未確認」のものをまとめて「出ていない」にする (#377)。
 * 雑誌のページのように、出ているものだけ ✅ を付けて残りを一括で片付ける用途。
 * 対象はクライアントから受け取らず、親のリレーションからサーバーで引き直す
 */
export async function markUncheckedChildrenAbsent(
  parentId: string
): Promise<{ error?: string; count?: number }> {
  const user = await requireRole(["admin", "member"]);
  const relations = await getAssetRelations(parentId, user.clearance);
  const childIds = relations.asSource
    .filter((r) => r.target.kind === "image" || r.target.kind === "video")
    .map((r) => r.targetId);
  const media = await getClipMedia(user.clearance, childIds);
  const targets = [...media].filter(([, m]) => m.appearance === "unchecked").map(([id]) => id);

  let failed = 0;
  for (let i = 0; i < targets.length; i += BULK_CONCURRENCY) {
    const results = await Promise.allSettled(
      targets
        .slice(i, i + BULK_CONCURRENCY)
        .map((id) => setNinaAppearance(id, "absent", user.id, user.clearance))
    );
    failed += results.filter((r) => r.status === "rejected").length;
  }

  invalidateAssets();
  revalidatePath(`/assets/${parentId}`);
  const count = targets.length - failed;
  if (failed > 0) return { error: `${failed} 件の記録に失敗しました。もう一度試してください`, count };
  return { count };
}
