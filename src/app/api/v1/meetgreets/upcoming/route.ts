import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { listUpcomingPreviews } from "@/lib/domain/meetgreet-preview";
import { projectUpcomingPreview } from "@/lib/meetgreet/api";

/**
 * 予告コーデのある、開催日が今日 (JST) 以降の回 (#203)。公開サイトがビルド時に読む。
 * `?all=1` なら予告の無い回も返す (#242)。既定を変えないのは、古いサイトのビルドが予告の空の行を
 * そのまま並べてしまうため。
 * 過去の回を隠すのはサイト側でも行う (ビルドが古いと「今日」がずれるため)
 */
export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const all = new URL(request.url).searchParams.get("all") === "1";
  const rows = await listUpcomingPreviews(auth.clearance, undefined, { all });
  return NextResponse.json({ items: rows.map(projectUpcomingPreview) });
}
