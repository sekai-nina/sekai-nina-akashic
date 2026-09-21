/**
 * ライブの衣装スケッチ (#150)。処理本体は sketch.ts (ミーグリと共用)。
 * ここは Live テーブルへの書き込み先と名前を渡すだけ。
 */

import type { Prisma } from "@prisma/client";
import type { TransactionClient } from "@/lib/db";
import type { CropRect } from "@/lib/meetgreet/crop";
import {
  generateSketch as generate,
  saveSketchCrops as saveCrops,
  selectSketch as select,
  type GenerateSketchOptions,
  type SketchOwner,
  type SketchStore,
} from "./sketch";
import { LiveInputError, type ActingUser } from "./lives";

export { listSketchSources, type GenerateSketchOptions } from "./sketch";

/** Live への書き込み先 */
export const liveSketchStore: SketchStore = {
  kind: "live",
  targetType: "Live",
  noun: "ライブ",
  inputError: LiveInputError,
  async appendCandidates(tx: TransactionClient, id: string, keys: string[]) {
    await tx.$executeRaw`
      UPDATE "Live"
      SET "sketchCandidates" = "sketchCandidates" || ${JSON.stringify(keys)}::jsonb,
          "updatedAt" = NOW()
      WHERE id = ${id}
    `;
  },
  async readRefs(tx, id) {
    const row = await tx.live.findUnique({ where: { id }, select: { sketchRefs: true } });
    return row?.sketchRefs;
  },
  async update(tx, id, data) {
    await tx.live.update({
      where: { id },
      data: {
        ...(data.sketchRefs !== undefined ? { sketchRefs: data.sketchRefs as Prisma.InputJsonValue } : {}),
        ...(data.sketchCrops !== undefined ? { sketchCrops: data.sketchCrops as Prisma.InputJsonValue } : {}),
        ...(data.sketchKey !== undefined ? { sketchKey: data.sketchKey } : {}),
      },
    });
  },
};

export function generateSketch(user: ActingUser, live: SketchOwner, options: GenerateSketchOptions) {
  return generate(liveSketchStore, user, live, options);
}



export function saveSketchCrops(
  user: ActingUser,
  live: { id: string; dossierId: string; sketchCrops: unknown; sketchRefs: unknown },
  changes: Record<string, CropRect | null>
) {
  return saveCrops(liveSketchStore, user, live, changes);
}

export function selectSketch(user: ActingUser, live: { id: string; sketchCandidates: unknown }, key: string) {
  return select(liveSketchStore, user, live, key);
}
