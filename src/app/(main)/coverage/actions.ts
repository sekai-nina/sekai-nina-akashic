"use server";

import { revalidatePath, updateTag } from "next/cache";
import { CoverageInputError, CoveragePermissionError } from "@/lib/coverage/collection";
import { COVERAGE_LABELS } from "@/lib/utils";
import { auth } from "@/lib/auth";
import {
  createDataSource,
  updateDataSource,
  setCollectedUntil,
  DERIVED_ITEMS_TAG,
  type CreateDataSourceInput,
  type UpdateDataSourceInput,
} from "@/lib/domain/coverage";

/** admin / member は編集可、viewer は閲覧のみ。 */
async function requireEditor() {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");
  if (!["admin", "member"].includes(session.user.role)) throw new Error("Forbidden");
  return session.user;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// ---- 手入力の収集済みの日付 ----

export async function setCollectedUntilAction(dataSourceKey: string, collectedUntil: string | null) {
  const user = await requireEditor();
  try {
    await setCollectedUntil(dataSourceKey, collectedUntil, user.clearance, user.id);
    revalidatePath("/coverage");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof CoverageInputError || e instanceof CoveragePermissionError ? e.message : COVERAGE_LABELS.failed };
  }
}

// ---- data sources ----

export async function createDataSourceAction(input: CreateDataSourceInput) {
  const user = await requireEditor();
  try {
    const ds = await createDataSource(input, user.clearance, user.id);
    revalidatePath("/coverage");
    return { ok: true as const, id: ds.id };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function updateDataSourceAction(id: string, input: UpdateDataSourceInput) {
  const user = await requireEditor();
  try {
    await updateDataSource(id, input, user.clearance, user.id);
    // itemRule / パターンを変えると素材の導出が変わる（/coverage の件数と /progress）
    updateTag(DERIVED_ITEMS_TAG);
    revalidatePath("/coverage");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}
