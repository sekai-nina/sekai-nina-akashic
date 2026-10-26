import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getLive, LiveInputError, replacePerformanceSetlist } from "@/lib/domain/lives";
import { PerformanceSetlistSchema, projectLive } from "@/lib/live/api";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ id: string; performanceId: string }> };

/**
 * 1 公演のセトリ (出ていない曲も含めた全曲) を丸ごと入れ替える。
 * ライブの共通披露曲 / 追加曲 / センター曲はセトリから組み直される (参加した曲だけ)。
 * `items: []` でその公演のセトリを消す。
 */
export async function PUT(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id, performanceId } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = PerformanceSetlistSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  const existing = await getLive(auth, id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    await replacePerformanceSetlist(auth, existing, performanceId, parsed.data.items);
  } catch (e) {
    if (e instanceof LiveInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
  const live = await getLive(auth, id);
  if (!live) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(projectLive(live));
}
