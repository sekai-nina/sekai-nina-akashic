"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/require-role";
import { invalidateDossiers } from "@/lib/cache";
import {
  QuoteInputError,
  setBlogQuoteExcluded,
  setQuotePassage,
  startBlogQuoteDossier,
} from "@/lib/domain/blog-quotes";

const requireMember = () => requireRole(["admin", "member"]);

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function fail(e: unknown): { ok: false; error: string } {
  // 想定内の入力エラーだけ文言を返す。それ以外は中身を画面に出さない
  if (e instanceof QuoteInputError) return { ok: false, error: e.message };
  console.error(e);
  return { ok: false, error: "失敗しました" };
}

/** 言葉記事用のドシエを用意して、ブログ本文の範囲選択 (アセット画面) へ */
export async function startBlogQuoteAction(assetId: string): Promise<Result<{ href: string }>> {
  const user = await requireMember();
  try {
    const dossierId = await startBlogQuoteDossier(user, assetId);
    invalidateDossiers();
    revalidatePath("/quotes");
    return { ok: true, href: `/assets/${assetId}?dossier=${dossierId}` };
  } catch (e) {
    return fail(e);
  }
}

export async function setBlogQuoteExcludedAction(assetId: string, excluded: boolean, note: string): Promise<Result> {
  const user = await requireMember();
  try {
    await setBlogQuoteExcluded(user, assetId, excluded === true, String(note ?? "").slice(0, 200));
    revalidatePath("/quotes");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function setQuotePassageAction(
  shortId: string,
  index: number,
  on: boolean,
  expectedText: string
): Promise<Result> {
  const user = await requireMember();
  if (!Number.isInteger(index) || index < 0 || typeof expectedText !== "string") {
    return { ok: false, error: "引用の指定が不正です" };
  }
  try {
    await setQuotePassage(user, String(shortId), index, on === true, expectedText);
    revalidatePath(`/quotes/${shortId}`);
    revalidatePath("/quotes");
    revalidatePath(`/articles/${shortId}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
