import { withClearance } from "@/lib/db";
import { InstaTargetError, normalizeHandle } from "@/lib/insta/targets";

/**
 * insta-watch が story を取りに行くときに使う Instagram アカウント。**1 行だけ。**
 *
 * **パスワードは持たない。** 認証情報は bot サーバの `.env` にだけ置き、初回ログインは
 * 人が `insta-watch login --headful` で行う（スマホ承認が要る）。ここが持つのは
 * 「どの垢を使っているか」と「セッションが生きているか」だけで、**ssh しなくても
 * 状態が分かる**ようにするのが目的。
 *
 * 複数を抱えて切り替える作りにはしない。
 */

export const SINGLETON_ID = "singleton";

export interface InstaAccountView {
  username: string;
  note: string;
  sessionValid: boolean;
  sessionCheckedAt: Date | null;
  lastLoginAt: Date | null;
  lastError: string;
  updatedAt: Date | null;
  updatedByName: string | null;
  /** 未設定（ユーザー名が空）か */
  configured: boolean;
}

const EMPTY: InstaAccountView = {
  username: "",
  note: "",
  sessionValid: false,
  sessionCheckedAt: null,
  lastLoginAt: null,
  lastError: "",
  updatedAt: null,
  updatedByName: null,
  configured: false,
};

export async function getInstaAccount(clearance: string): Promise<InstaAccountView> {
  const row = await withClearance(clearance, (tx) =>
    tx.instaAccount.findUnique({
      where: { id: SINGLETON_ID },
      include: { updatedBy: { select: { name: true } } },
    })
  );
  if (!row) return EMPTY;
  return {
    username: row.username,
    note: row.note,
    sessionValid: row.sessionValid,
    sessionCheckedAt: row.sessionCheckedAt,
    lastLoginAt: row.lastLoginAt,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
    updatedByName: row.updatedBy?.name ?? null,
    configured: row.username.length > 0,
  };
}

/** 画面から登録する。**パスワードは受け取らない。** */
export async function setInstaAccount(
  input: { username: string; note: string },
  clearance: string,
  userId: string,
): Promise<InstaAccountView> {
  if (!input.username.trim()) throw new InstaTargetError("ユーザー名を入れてください");
  const username = normalizeHandle(input.username);
  const note = input.note.slice(0, 200);

  await withClearance(clearance, async (tx) => {
    const prev = await tx.instaAccount.findUnique({
      where: { id: SINGLETON_ID },
      select: { username: true },
    });
    // **垢を替えたらセッションの記録を落とす。** 残したままだと、前の垢のセッションが
    // 生きているかのように見え続け、「ログイン済みのはずなのに story が取れない」になる
    const switched = prev != null && prev.username !== username;
    const reset = switched
      ? { sessionValid: false, sessionCheckedAt: null, lastLoginAt: null, lastError: "" }
      : {};

    await tx.instaAccount.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, username, note, updatedById: userId },
      update: { username, note, updatedById: userId, ...reset },
    });
  });

  return getInstaAccount(clearance);
}

/** bot が報告するセッションの状態 */
export async function reportInstaSession(
  input: { valid: boolean; error?: string; loggedInAt?: Date },
  clearance: string,
): Promise<void> {
  await withClearance(clearance, (tx) =>
    tx.instaAccount.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        sessionValid: input.valid,
        sessionCheckedAt: new Date(),
        lastError: input.error?.slice(0, 300) ?? "",
        lastLoginAt: input.loggedInAt ?? null,
      },
      update: {
        sessionValid: input.valid,
        sessionCheckedAt: new Date(),
        lastError: input.valid ? "" : (input.error?.slice(0, 300) ?? ""),
        ...(input.loggedInAt ? { lastLoginAt: input.loggedInAt } : {}),
      },
    })
  );
}
