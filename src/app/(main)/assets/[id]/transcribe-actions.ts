"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/require-role";
import { invalidateAssets } from "@/lib/cache";
import { transcribeAssetForUser } from "@/lib/domain/transcribe";
import { isGroqConfigured } from "@/lib/transcribe/groq";

/** アセット詳細の「文字起こし」(#282)。文字起こし済みなら置き換える */
export async function transcribeAsset(assetId: string): Promise<{ error?: string; empty?: boolean }> {
  const user = await requireRole(["admin", "member"]);
  if (!isGroqConfigured()) return { error: "GROQ_API_KEY が未設定です" };
  const res = await transcribeAssetForUser(assetId, user);
  if (res.error) return { error: res.error };
  invalidateAssets();
  revalidatePath(`/assets/${assetId}`);
  return { empty: !res.text };
}
