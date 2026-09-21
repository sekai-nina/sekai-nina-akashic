import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import {
  deleteLive,
  getLive,
  listMaterialCandidates,
  LiveInputError,
  updateLive,
} from "@/lib/domain/lives";
import { projectLive, UpdateLiveSchema } from "@/lib/live/api";
import { projectCandidates } from "@/lib/meetgreet/api";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const live = await getLive(auth, id);
  if (!live) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const candidates = await listMaterialCandidates(auth, live);
  return NextResponse.json({ ...projectLive(live), candidates: projectCandidates(candidates) });
}

export async function PATCH(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = UpdateLiveSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  const existing = await getLive(auth, id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    await updateLive(auth, id, parsed.data);
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

/** Live の行だけ消す。ドシエ / 収集 / event エンティティは残る */
export async function DELETE(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const existing = await getLive(auth, id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await deleteLive(auth, id);
  return new NextResponse(null, { status: 204 });
}
