import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiAuth } from "@/lib/api-auth";
import { SCENE_WORKER_PERMISSION } from "@/lib/video-scenes/policy";
import { claimSceneTask, discoverSceneTask, updateSceneTask, initiateSceneFile, completeSceneFile, SceneInputError, SceneLeaseError } from "@/lib/domain/video-scenes";

export const maxDuration = 30;
const lease = { taskId: z.string().min(1).max(100), token: z.string().uuid() };
const Input = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("claim"), kind: z.literal("export").optional() }),
  z.object({ operation: z.literal("discover") }),
  z.object({ operation: z.literal("heartbeat"), ...lease }),
  z.object({ operation: z.literal("fail"), ...lease }),
  z.object({ operation: z.literal("complete"), ...lease, result: z.unknown() }),
  z.object({ operation: z.literal("upload"), ...lease, slot: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), mimeType: z.enum(["image/jpeg", "video/mp4"]) }),
  z.object({ operation: z.literal("uploaded"), ...lease, fileId: z.string().min(1).max(100), driveFileId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) }),
]);

export async function POST(request: Request) {
  const actor = await requireApiAuth(request, [SCENE_WORKER_PERMISSION, "write"]);
  if (actor instanceof NextResponse) return actor;
  if (!["admin", "member"].includes(actor.role)) return NextResponse.json({ error: "編集権限が必要です" }, { status: 403 });
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > 1_000_000) return NextResponse.json({ error: "入力が大きすぎます" }, { status: 413 });
    const parsed = Input.safeParse(JSON.parse(raw));
    if (!parsed.success) return NextResponse.json({ error: "依頼の形式が違います" }, { status: 400 });
    const input = parsed.data;
    const headers = { "Cache-Control": "private, no-store" };
    if (input.operation === "claim") return NextResponse.json({ task: await claimSceneTask(actor, input.kind === "export") }, { headers });
    if (input.operation === "discover") return NextResponse.json({ task: await discoverSceneTask(actor) }, { headers });
    if (input.operation === "upload") return NextResponse.json(await initiateSceneFile(actor, input.taskId, input.token, input.slot, input.mimeType), { headers });
    if (input.operation === "uploaded") return NextResponse.json(await completeSceneFile(actor, input.taskId, input.token, input.fileId, input.driveFileId), { headers });
    await updateSceneTask(actor, input.taskId, input.token, input.operation, input.operation === "complete" ? input.result : undefined);
    return NextResponse.json({ ok: true }, { headers });
  } catch (error) {
    if (error instanceof SceneInputError) return NextResponse.json({ error: error.message }, { status: error instanceof SceneLeaseError ? 409 : 400 });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "JSON の形式が違います" }, { status: 400 });
    return NextResponse.json({ error: "動画の処理に失敗しました" }, { status: 500 });
  }
}
