import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getLive, refetchReports } from "@/lib/domain/lives";

type Params = { params: Promise<{ id: string }> };

/** 収集は X API + 画像アップロードなので長い */
export const maxDuration = 300;

/** X レポの (再) 収集。keep / total は GET /lives/:id で読む */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const live = await getLive(auth, id);
  if (!live) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // 収集が紐づいていないのは呼び出し側の状態の問題 (409)、X API の失敗は上流の問題 (502)
  if (!live.repoCollectionId) {
    return NextResponse.json({ error: "X レポ収集が紐づいていません" }, { status: 409 });
  }
  const outcome = await refetchReports(auth, live);
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: 502 });
  return NextResponse.json(outcome.result);
}
