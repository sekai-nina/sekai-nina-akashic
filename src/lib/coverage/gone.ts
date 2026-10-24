import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";

const MESSAGE =
  "観点（Lens）ごとの管理は終了しました。収集済みの日付は GET /api/v1/coverage/summary、手入力は PATCH /api/v1/datasources/{id} の collectedUntil を使ってください。";

/** 観点まわりの旧 API (#253 で終了)。認証と権限の検証は維持し、本文は読まずに 410 を返す。 */
export async function lensApiGone(request: Request, permission: "read" | "write") {
  const auth = await requireApiAuth(request, permission);
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ error: MESSAGE }, { status: 410 });
}
