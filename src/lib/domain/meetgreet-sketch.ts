/**
 * ミーグリの服装スケッチ (#108)。処理本体は sketch.ts (#150 でライブと共用)。
 * ここは MeetGreet テーブルへの書き込み先と名前を渡すだけ。
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
import { MeetGreetInputError, type ActingUser } from "./meetgreets";

export { listSketchSources, type GenerateSketchOptions } from "./sketch";

/** MeetGreet への書き込み先 */
export const meetGreetSketchStore: SketchStore = {
  kind: "meetgreet",
  targetType: "MeetGreet",
  noun: "回",
  inputError: MeetGreetInputError,
  async appendCandidates(tx: TransactionClient, id: string, keys: string[]) {
    // 同時に 2 回生成されても取りこぼさないよう、読み書きではなく jsonb の追記で足す
    await tx.$executeRaw`
      UPDATE "MeetGreet"
      SET "sketchCandidates" = "sketchCandidates" || ${JSON.stringify(keys)}::jsonb,
          "updatedAt" = NOW()
      WHERE id = ${id}
    `;
  },
  async readRefs(tx, id) {
    const row = await tx.meetGreet.findUnique({ where: { id }, select: { sketchRefs: true } });
    return row?.sketchRefs;
  },
  async update(tx, id, data) {
    await tx.meetGreet.update({
      where: { id },
      data: {
        ...(data.sketchRefs !== undefined ? { sketchRefs: data.sketchRefs as Prisma.InputJsonValue } : {}),
        ...(data.sketchCrops !== undefined ? { sketchCrops: data.sketchCrops as Prisma.InputJsonValue } : {}),
        ...(data.sketchKey !== undefined ? { sketchKey: data.sketchKey } : {}),
      },
    });
  },
};

export function generateSketch(user: ActingUser, meetGreet: SketchOwner, options: GenerateSketchOptions) {
  return generate(meetGreetSketchStore, user, meetGreet, options);
}



export function saveSketchCrops(
  user: ActingUser,
  meetGreet: { id: string; dossierId: string; sketchCrops: unknown; sketchRefs: unknown },
  changes: Record<string, CropRect | null>
) {
  return saveCrops(meetGreetSketchStore, user, meetGreet, changes);
}

export function selectSketch(user: ActingUser, meetGreet: { id: string; sketchCandidates: unknown }, key: string) {
  return select(meetGreetSketchStore, user, meetGreet, key);
}
