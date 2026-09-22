import { NextResponse } from "next/server";
import { startStoryJob } from "@/lib/domain/insta-jobs";
import { instaJobErrorResponse, instaJobToJson, requireInstaJobAuth } from "@/lib/insta/api";

type Params = { params: Promise<{ id: string }> };

/** iPad のラッパー Shortcut がジョブを受け取った報告。dispatched → processing (冪等) */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireInstaJobAuth(request, "worker");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  try {
    const job = await startStoryJob(id, auth.clearance);
    return NextResponse.json(instaJobToJson(job));
  } catch (e) {
    return instaJobErrorResponse(e);
  }
}
