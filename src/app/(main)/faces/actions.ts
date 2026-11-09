"use server";

import { revalidateTag } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { invalidateAssetList } from "@/lib/cache";
import {
  FACE_REVIEW_CACHE_TAG,
  FaceReviewInputError,
  REVIEW_MAX_DECISIONS,
  reviewFaces,
  type FaceReviewResult,
} from "@/lib/domain/face-review";

const Decision = z.discriminatedUnion("action", [
  z.object({ faceId: z.string().min(1), action: z.literal("confirm") }),
  z.object({ faceId: z.string().min(1), action: z.literal("reject") }),
  z.object({ faceId: z.string().min(1), action: z.literal("nonmember") }),
  z.object({ faceId: z.string().min(1), action: z.literal("other"), entityId: z.string().min(1) }),
]);
const Decisions = z.array(Decision).min(1).max(REVIEW_MAX_DECISIONS);

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
    return { ok: true, result };
  } catch (err) {
    if (err instanceof FaceReviewInputError) return { ok: false, error: err.message };
    throw err;
  }
}
