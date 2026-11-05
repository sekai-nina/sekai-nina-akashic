/**
 * X レポ収集の検索ワードのプリセット。
 *
 * 画面から足す・直す・消す。行は `internal` 固定で、機密の回の条件を置く場所ではない
 * (機密の回は回ごとの編集で足りる)。読み書きは `withClearance` を通す (保護テーブル)。
 */

import { Prisma, type ClearanceLevel } from "@prisma/client";
import { accessibleClassifications, assertClearance } from "@/lib/classification";
import { withClearance, type TransactionClient } from "@/lib/db";
import { storedGroups, type ReportSearch } from "@/lib/meetgreet/report-query";
import type { HashtagGroup } from "@/lib/twitter/x-search";
import { logAudit } from "./audit";
import type { ActingUser } from "./article-workflow";

const PRESET_CLASSIFICATION: ClearanceLevel = "internal";

/** この機密の回の条件をプリセットに写してよいか (プリセットは internal の全員に見える) */
export function canSaveAsPreset(classification: string): boolean {
  return accessibleClassifications(PRESET_CLASSIFICATION).includes(classification as ClearanceLevel);
}

function isMissingRecord(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}

export interface RepoPreset {
  id: string;
  name: string;
  groups: HashtagGroup[];
  extra: string;
}

/** `withClearance` の中で読む */
export async function listRepoPresetsIn(tx: TransactionClient): Promise<RepoPreset[]> {
  const rows = await tx.repoQueryPreset.findMany({
    orderBy: [{ createdAt: "asc" }, { name: "asc" }],
    select: { id: true, name: true, groups: true, extra: true },
  });
  return rows.map((r) => ({ ...r, groups: storedGroups(r.groups) }));
}

/** `id` があれば上書き、無ければ新規。名前が重なるときは入力の問題として返す */
export async function saveRepoPreset(
  user: ActingUser,
  input: { id?: string; name: string; search: ReportSearch }
): Promise<{ id: string }> {
  assertClearance(user.clearance, PRESET_CLASSIFICATION);
  const data = {
    name: input.name,
    groups: input.search.groups as unknown as Prisma.InputJsonValue,
    extra: input.search.extra,
    classification: PRESET_CLASSIFICATION,
  };
  let saved: { id: string };
  try {
    saved = await withClearance(user.clearance, (tx) =>
      input.id
        ? tx.repoQueryPreset.update({ where: { id: input.id }, data, select: { id: true } })
        : tx.repoQueryPreset.create({ data, select: { id: true } })
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new Error(`「${input.name}」という名前のプリセットは既にあります`);
    }
    if (isMissingRecord(e)) throw new Error("プリセットが見つかりません (消された可能性があります)");
    throw e;
  }
  await logAudit({
    actorId: user.id,
    action: input.id ? "repo_preset.update" : "repo_preset.create",
    targetType: "RepoQueryPreset",
    targetId: saved.id,
    metadata: { name: input.name },
  });
  return saved;
}

export async function deleteRepoPreset(user: ActingUser, id: string): Promise<void> {
  assertClearance(user.clearance, PRESET_CLASSIFICATION);
  try {
    await withClearance(user.clearance, (tx) => tx.repoQueryPreset.delete({ where: { id } }));
  } catch (e) {
    if (isMissingRecord(e)) throw new Error("プリセットが見つかりません (消された可能性があります)");
    throw e;
  }
  await logAudit({
    actorId: user.id,
    action: "repo_preset.delete",
    targetType: "RepoQueryPreset",
    targetId: id,
  });
}
