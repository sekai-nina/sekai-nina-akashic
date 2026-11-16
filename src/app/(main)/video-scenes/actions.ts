"use server";

import { auth } from "@/lib/auth";
import { requestSceneTask, SceneInputError } from "@/lib/domain/video-scenes";

export async function generateVideoScenes(assetId: string) {
  const session = await auth();
  if (!session?.user) return { ok: false as const, error: "ログインしてください" };
  try {
    return { ok: true as const, task: await requestSceneTask(session.user, assetId) };
  } catch (error) {
    return { ok: false as const, error: error instanceof SceneInputError ? error.message : "生成を依頼できませんでした" };
  }
}

export async function exportVideoScene(assetId: string, start: number, end: number) {
  const session = await auth();
  if (!session?.user) return { ok: false as const, error: "ログインしてください" };
  try {
    return { ok: true as const, task: await requestSceneTask(session.user, assetId, { start, end }) };
  } catch (error) {
    return { ok: false as const, error: error instanceof SceneInputError ? error.message : "保存用の動画を依頼できませんでした" };
  }
}
