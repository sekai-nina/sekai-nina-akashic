import type { InstaWatchTier } from "@prisma/client";
import { withClearance } from "@/lib/db";
import { InstaTargetError, TIER_DEFAULT_MINUTES, normalizeHandle } from "@/lib/insta/targets";

/**
 * insta-watch の監視対象ハンドル。
 *
 * bot 側の `config/accounts.txt` を置き換える。**誰を見ているかは運用判断**なので、
 * サーバに ssh して編集するのではなく画面から足せるようにした。
 *
 * bot は `GET /api/v1/insta/targets` で読む。**bot 側は最後に読めた一覧を保持する**
 * 設計（ここが一時的に落ちても監視は止まらない）。
 */

export {
  HANDLE_PATTERN,
  InstaTargetError,
  TIER_DEFAULT_MINUTES,
  normalizeHandle,
} from "@/lib/insta/targets";

export interface InstaTargetView {
  id: string;
  handle: string;
  tier: InstaWatchTier;
  intervalMinutes: number | null;
  /** 実際に使われる間隔 (分)。明示指定が無ければ tier の既定 */
  effectiveMinutes: number;
  enabled: boolean;
  note: string;
  updatedAt: Date;
  updatedByName: string | null;
}

function toView(row: {
  id: string;
  handle: string;
  tier: InstaWatchTier;
  intervalMinutes: number | null;
  enabled: boolean;
  note: string;
  updatedAt: Date;
  updatedBy: { name: string | null } | null;
}): InstaTargetView {
  return {
    id: row.id,
    handle: row.handle,
    tier: row.tier,
    intervalMinutes: row.intervalMinutes,
    effectiveMinutes: row.intervalMinutes ?? TIER_DEFAULT_MINUTES[row.tier],
    enabled: row.enabled,
    note: row.note,
    updatedAt: row.updatedAt,
    updatedByName: row.updatedBy?.name ?? null,
  };
}

const SELECT = {
  id: true,
  handle: true,
  tier: true,
  intervalMinutes: true,
  enabled: true,
  note: true,
  updatedAt: true,
  updatedBy: { select: { name: true } },
} as const;

export async function listInstaTargets(clearance: string): Promise<InstaTargetView[]> {
  const rows = await withClearance(clearance, (tx) =>
    tx.instaWatchTarget.findMany({ orderBy: [{ enabled: "desc" }, { handle: "asc" }], select: SELECT })
  );
  return rows.map(toView);
}

export async function addInstaTarget(
  input: { handle: string; tier: InstaWatchTier; intervalMinutes: number | null; note: string },
  clearance: string,
  userId: string,
): Promise<InstaTargetView> {
  const handle = normalizeHandle(input.handle);
  if (input.intervalMinutes != null && (input.intervalMinutes < 1 || input.intervalMinutes > 10080)) {
    throw new InstaTargetError("間隔は 1 分〜1 週間で指定してください");
  }
  const row = await withClearance(clearance, (tx) =>
    // 一度外したハンドルを入れ直すことがあるので upsert。note と tier は入力で上書きする
    tx.instaWatchTarget.upsert({
      where: { handle },
      create: {
        handle,
        tier: input.tier,
        intervalMinutes: input.intervalMinutes,
        note: input.note.slice(0, 200),
        updatedById: userId,
      },
      update: {
        tier: input.tier,
        intervalMinutes: input.intervalMinutes,
        note: input.note.slice(0, 200),
        enabled: true,
        updatedById: userId,
      },
      select: SELECT,
    })
  );
  return toView(row);
}

export async function setInstaTargetEnabled(
  id: string,
  enabled: boolean,
  clearance: string,
  userId: string,
): Promise<void> {
  await withClearance(clearance, (tx) =>
    tx.instaWatchTarget.update({ where: { id }, data: { enabled, updatedById: userId } })
  );
}

export async function deleteInstaTarget(id: string, clearance: string): Promise<void> {
  await withClearance(clearance, (tx) => tx.instaWatchTarget.delete({ where: { id } }));
}

/** bot が読む形。**有効なものだけ**返す */
export async function getEnabledInstaTargets(
  clearance: string,
): Promise<{ handle: string; tier: InstaWatchTier; intervalMinutes: number }[]> {
  const rows = await withClearance(clearance, (tx) =>
    tx.instaWatchTarget.findMany({
      where: { enabled: true },
      orderBy: { handle: "asc" },
      select: { handle: true, tier: true, intervalMinutes: true },
    })
  );
  return rows.map((r) => ({
    handle: r.handle,
    tier: r.tier,
    intervalMinutes: r.intervalMinutes ?? TIER_DEFAULT_MINUTES[r.tier],
  }));
}
