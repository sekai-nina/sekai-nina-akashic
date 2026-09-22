import { NextResponse } from "next/server";
import { completeStoryJob } from "@/lib/domain/insta-jobs";
import { instaJobErrorResponse, instaJobToJson, requireInstaJobAuth } from "@/lib/insta/api";

type Params = { params: Promise<{ id: string }> };

// Discord へ添付を送る (Drive から読み直す) ので、動画数本ぶんの時間を見る
export const maxDuration = 60;

/**
 * 完了の報告。ファイルが 1 件も届いていなければ failed になる。
 * completed になったら Discord に流し、次の pending ジョブを iPad に送る。
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireInstaJobAuth(request, "worker");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  try {
    const res = await completeStoryJob(id, auth.clearance);
    return NextResponse.json({
      ...instaJobToJson(res.job),
      notified: res.notified,
      notifyError: res.notifyError,
      nextDispatchedId: res.next.dispatchedId,
    });
  } catch (e) {
    return instaJobErrorResponse(e);
  }
}
