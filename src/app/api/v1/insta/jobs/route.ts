import { NextResponse } from "next/server";
import { z } from "zod";
import { createStoryJob, listStoryJobs, LIST_MAX_LIMIT } from "@/lib/domain/insta-jobs";
import { instaJobErrorResponse, instaJobToJson, requireInstaJobAuth } from "@/lib/insta/api";
import { HANDLE_PATTERN } from "@/lib/insta/targets";
import { formatZodError } from "@/lib/zod-error";

/**
 * story ジョブ (#178)。
 *
 * POST: insta-watch が story を検知したら叩く。作ると同時に、iPad が空いていれば Pushcut で送る。
 * 同じハンドルのジョブが進行中ならそれを返す (200)。
 * GET:  デバッグ・管理用の一覧。
 */
export const dynamic = "force-dynamic";
// 作成時に Pushcut へ送る (15 秒でタイムアウト)
export const maxDuration = 30;

const CreateBody = z.object({ url: z.string().min(1).max(500) }).strict();

const STATUSES = ["pending", "dispatched", "processing", "completed", "failed"] as const;

export async function GET(request: Request) {
  const auth = await requireInstaJobAuth(request, "list");
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const statusRaw = searchParams.get("status");
  const status = STATUSES.find((s) => s === statusRaw);
  if (statusRaw && !status) {
    return NextResponse.json({ error: `status must be one of ${STATUSES.join(", ")}` }, { status: 400 });
  }
  const limitRaw = searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit != null && (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT)) {
    return NextResponse.json({ error: `limit must be 1..${LIST_MAX_LIMIT}` }, { status: 400 });
  }
  const handle = searchParams.get("handle")?.trim().toLowerCase() || undefined;
  if (handle && !HANDLE_PATTERN.test(handle)) {
    return NextResponse.json({ error: "handle の形式が不正です" }, { status: 400 });
  }

  const jobs = await listStoryJobs({ status, handle, limit }, auth.clearance);
  return NextResponse.json({ jobs: jobs.map(instaJobToJson) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const auth = await requireInstaJobAuth(request, "create");
  if (auth instanceof NextResponse) return auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  try {
    const res = await createStoryJob({ url: parsed.data.url }, { id: auth.id, clearance: auth.clearance });
    return NextResponse.json(
      { ...instaJobToJson(res.job), existing: res.existing, dispatch: res.dispatch },
      { status: res.existing ? 200 : 201 },
    );
  } catch (e) {
    return instaJobErrorResponse(e);
  }
}
