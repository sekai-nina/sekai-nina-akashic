import { NextResponse } from "next/server";
import { getStoryJob } from "@/lib/domain/insta-jobs";
import { instaJobToJson, requireInstaJobAuth } from "@/lib/insta/api";

type Params = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/** ジョブの詳細。iPad ワーカーのキー (insta_worker) からも読める */
export async function GET(request: Request, { params }: Params) {
  const auth = await requireInstaJobAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const job = await getStoryJob(id, auth.clearance);
  if (!job) return NextResponse.json({ error: "ジョブが見つかりません" }, { status: 404 });
  return NextResponse.json(instaJobToJson(job), { headers: { "Cache-Control": "no-store" } });
}
