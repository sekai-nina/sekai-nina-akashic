import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";

/** 観点別のアイテムチェックは #233 段階3で終了。既存の記録は保存する。 */
export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json(
    { error: "観点別のアイテムチェックは終了しました。素材のクリップ済は /progress で管理してください。" },
    { status: 410 }
  );
}
