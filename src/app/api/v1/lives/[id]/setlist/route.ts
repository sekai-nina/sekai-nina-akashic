import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getLive, LiveInputError, replaceSetlist } from "@/lib/domain/lives";
import { projectLive, SetlistSchema } from "@/lib/live/api";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ id: string }> };

/**
 * 公演と曲を丸ごと入れ替える。`id` 付きの公演は残して更新し、無いものは消す。
 * 曲名は `Song` に find-or-create される (表記揺れは /entities と同じく人が直す)。
 */
export async function PUT(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = SetlistSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  const existing = await getLive(auth, id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    await replaceSetlist(auth, existing, parsed.data);
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
