import type { InstaWatchTier } from "@prisma/client";

/**
 * 監視対象まわりの純粋な部分。**DB を触らないモジュールに置く。**
 *
 * ドメイン層 (`src/lib/domain/insta-targets.ts`) に置くと、これを使うテストが
 * `@/lib/db` を巻き込み、DATABASE_URL の無い CI で PrismaClient の生成に失敗する
 * （同じ轍を costs で 2 回踏んでいる）。
 */

/** tier ごとの既定間隔 (分)。bot 側の既定と揃えること */
export const TIER_DEFAULT_MINUTES: Record<InstaWatchTier, number> = {
  hot: 10,
  normal: 18,
  cold: 240,
};

/** Instagram のハンドルとして受け付ける形 */
export const HANDLE_PATTERN = /^[a-z0-9._]{1,30}$/;

export class InstaTargetError extends Error {}

/**
 * 入力されたハンドルを均す。`@name` や URL を貼られても拾えるようにする
 * （画面から入れる値なので、形式を人に強いるより受け取る側で均すほうがよい）。
 */
export function normalizeHandle(raw: string): string {
  let h = raw.trim().toLowerCase();
  h = h.replace(/^https?:\/\/(www\.)?instagram\.com\//, "");
  h = h.replace(/^@/, "");
  h = h.replace(/[/?#].*$/, "");
  if (!HANDLE_PATTERN.test(h)) {
    throw new InstaTargetError(`ハンドルの形式が不正です: ${raw}`);
  }
  return h;
}
