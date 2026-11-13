"use server";

import { refresh, revalidateTag } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { invalidateAssetList } from "@/lib/cache";
import {
  FACE_REVIEW_CACHE_TAG,
  listReviewFaces,
  type ReviewFace,
  FaceDecisionsInput as Decisions,
  FaceReviewInputError,
  reviewFaces,
  type FaceReviewResult,
} from "@/lib/domain/face-review";

export type ReviewActionResult = { ok: true; result: FaceReviewResult } | { ok: false; error: string };

/** 顔の確定・却下 (#409)。admin / member だけ */
export async function submitFaceReview(input: unknown): Promise<ReviewActionResult> {
  const user = await requireRole(["admin", "member"]);
  const parsed = Decisions.safeParse(input);
  if (!parsed.success) return { ok: false, error: "送った内容の形が違います" };
  try {
    const result = await reviewFaces(user, parsed.data);
    if (result.tagsAdded > 0 || result.tagsRemoved > 0) invalidateAssetList();
    // メニューの数は古いものをすぐ返して裏で数え直す (確認のたびに数え直しを待たせない)
    revalidateTag(FACE_REVIEW_CACHE_TAG, "max");
    // タグの "max" だけでは Action の応答に画面の描き直しが入らない。ここで頼んで 1 往復で済ませる
    // (クライアントから描き直しを頼むと、もう 1 往復増える。docs/performance.md)
    refresh();
    return { ok: true, result };
  } catch (err) {
    if (err instanceof FaceReviewInputError) return { ok: false, error: err.message };
    throw err;
  }
}

const View = z.object({
  mode: z.enum(["pending", "auto"]),
  entityId: z.string().min(1).nullable(),
  page: z.number().int().min(1),
});

export type ReviewAndNextResult = { ok: true; result: FaceReviewResult; next: ReviewFace[] } | { ok: false; error: string };

/**
 * 顔の確認の画面用: 保存して、同じ条件の次の 1 ページ分の顔を返す。
 * 画面全体を描き直さない (refresh を呼ばない)。描き直すと一覧とメンバーごとの数を全部引き直すまで
 * 「保存中」のまま数秒待たされていた。保存した顔は条件 (status) から外れるので、同じページ番号で引けば次の顔になる。
 * メニューの数は古いまま (次に画面を開いたとき裏で数え直した値になる)。
 */
export async function submitFaceReviewAndNext(input: unknown, view: unknown): Promise<ReviewAndNextResult> {
  const user = await requireRole(["admin", "member"]);
  const parsed = Decisions.safeParse(input);
  const v = View.safeParse(view);
  if (!parsed.success || !v.success) return { ok: false, error: "送った内容の形が違います" };
  try {
    const result = await reviewFaces(user, parsed.data);
    if (result.tagsAdded > 0 || result.tagsRemoved > 0) invalidateAssetList();
    revalidateTag(FACE_REVIEW_CACHE_TAG, "max");
    const next = await listReviewFaces(user.clearance, v.data.mode, v.data.entityId, v.data.page);
    return { ok: true, result, next };
  } catch (err) {
    if (err instanceof FaceReviewInputError) return { ok: false, error: err.message };
    throw err;
  }
}
