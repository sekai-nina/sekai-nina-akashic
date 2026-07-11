"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import type { CoverageStatus } from "@prisma/client";
import {
  createLens,
  updateLens,
  createDataSource,
  updateDataSource,
  upsertCell,
  toggleCheck,
  bulkCheck,
  type CreateLensInput,
  type UpdateLensInput,
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

// ---- cell notes (not_applicable / メモ) ----

export async function upsertCellAction(input: {
  lensKey: string;
  dataSourceKey: string;
  status: CoverageStatus;
  note: string | null;
}) {
  const user = await requireEditor();
  try {
    const cell = await upsertCell(input, user.clearance, user.id);
    revalidatePath("/coverage");
    return { ok: true as const, cell };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

// ---- item checks ----

export async function toggleCheckAction(input: {
  lensKey: string;
  dataSourceKey: string;
  itemKey: string;
  checked: boolean;
}) {
  const user = await requireEditor();
  try {
    const result = await toggleCheck(input, user.clearance, user.id);
    revalidatePath(`/coverage/${input.dataSourceKey}`);
    revalidatePath("/coverage");
    return { ok: true as const, result };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function bulkCheckAction(input: {
  dataSourceKey: string;
  lensKeys: string[];
  untilDate: string;
  onlyMentionless?: boolean;
}) {
  const user = await requireEditor();
  try {
    const result = await bulkCheck(input, user.clearance, user.id);
    revalidatePath(`/coverage/${input.dataSourceKey}`);
    revalidatePath("/coverage");
    return { ok: true as const, result };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

// ---- lenses ----

export async function createLensAction(input: CreateLensInput) {
  const user = await requireEditor();
  try {
    const lens = await createLens(input, user.clearance, user.id);
    revalidatePath("/coverage");
    return { ok: true as const, id: lens.id };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}

export async function updateLensAction(id: string, input: UpdateLensInput) {
  const user = await requireEditor();
  try {
    await updateLens(id, input, user.clearance, user.id);
    revalidatePath("/coverage");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
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
    revalidatePath("/coverage");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errorMessage(e) };
  }
}
