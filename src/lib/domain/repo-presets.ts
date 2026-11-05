/**
 * X レポ収集の検索ワードのプリセット。
 *
 * 画面から足す・直す・消す。行は `internal` 固定で、機密の回の条件を置く場所ではない
 * (機密の回は回ごとの編集で足りる)。読み書きは `withClearance` を通す (保護テーブル)。
 */

import { Prisma, type ClearanceLevel } from "@prisma/client";
import { assertClearance } from "@/lib/classification";
import { withClearance } from "@/lib/db";
import { storedGroups, type ReportSearch } from "@/lib/meetgreet/report-query";
import type { HashtagGroup } from "@/lib/twitter/x-search";
import { logAudit } from "./audit";
import type { ActingUser } from "./meetgreets";

const PRESET_CLASSIFICATION: ClearanceLevel = "internal";

export interface RepoPreset {
  id: string;
  name: string;
  groups: HashtagGroup[];
  extra: string;
}

export async function listRepoPresets(clearance: string): Promise<RepoPreset[]> {
  const rows = await withClearance(clearance, (tx) =>
    tx.repoQueryPreset.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, groups: true, extra: true },
    })
  );
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
  await withClearance(user.clearance, (tx) => tx.repoQueryPreset.delete({ where: { id } }));
  await logAudit({
    actorId: user.id,
    action: "repo_preset.delete",
    targetType: "RepoQueryPreset",
    targetId: id,
  });
}
