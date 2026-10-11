"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/require-role";
import { QuoteInputError, setQuotePassage } from "@/lib/domain/blog-quotes";

const requireMember = () => requireRole(["admin", "member"]);

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function fail(e: unknown): { ok: false; error: string } {
  // 想定内の入力エラーだけ文言を返す。それ以外は中身を画面に出さない
  if (e instanceof QuoteInputError) return { ok: false, error: e.message };
  console.error(e);
  return { ok: false, error: "失敗しました" };
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
    revalidatePath("/progress/blog");
    revalidatePath(`/articles/${shortId}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
