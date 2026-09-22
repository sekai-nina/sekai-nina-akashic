import { NextResponse, after } from "next/server";
import { completeStoryJob, notifyStoryJobCompleted } from "@/lib/domain/insta-jobs";
import { instaJobErrorResponse, instaJobToJson, requireInstaJobAuth } from "@/lib/insta/api";

type Params = { params: Promise<{ id: string }> };

// 応答を返した後に Discord 用の動画変換 (ffmpeg) と添付の送信を after() で行う。
// 動画 1 本 30 秒前後 × 最大 10 件を見込む
export const maxDuration = 300;

/**
 * 完了の報告。ファイルが 1 件も届いていなければ failed になる。
 * completed になったら次の pending ジョブを iPad に送り、応答を返してから Discord に流す
 * (iPad の Shortcut を変換の間待たせない)。
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireInstaJobAuth(request, "worker");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  try {
    const res = await completeStoryJob(id, auth.clearance);
    if (res.shouldNotify) {
      after(async () => {
        const r = await notifyStoryJobCompleted(res.job);
        console.log(
          `insta job ${res.job.id}: Discord notified=${r.notified} attached=${r.attached}${r.error ? ` error=${r.error}` : ""}`,
        );
      });
    }
    return NextResponse.json({
      ...instaJobToJson(res.job),
      notifyScheduled: res.shouldNotify,
      nextDispatchedId: res.next.dispatchedId,
    });
  } catch (e) {
    return instaJobErrorResponse(e);
  }
}
