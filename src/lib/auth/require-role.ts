import { auth, type SessionUser } from "@/lib/auth";

/**
 * Server Action の入口で使う認可ヘルパー。
 *
 * `src/lib/actions.ts` と `(main)/articles/actions.ts` が module-private に持っていたものを共有化した
 * (#91)。他ページの actions にも同型の複製が残っており、順次こちらに寄せる。
 * 失敗は throw する (Server Action は例外をそのままクライアントに伝える)。
 */
export async function requireUser(): Promise<SessionUser> {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");
  return session.user;
}

/** 書き込み系は admin / member のみ (viewer を弾く) */
export async function requireRole(roles: string[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) throw new Error("Forbidden");
  return user;
}
