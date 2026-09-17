import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import {
  getMeetGreet,
  listMaterialCandidates,
  MeetGreetInputError,
  updateMeetGreet,
} from "@/lib/domain/meetgreets";
import { UpdateMeetGreetSchema, projectCandidates, projectMeetGreet } from "@/lib/meetgreet/api";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const mg = await getMeetGreet(auth, id);
  if (!mg) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const candidates = await listMaterialCandidates(auth, mg);
  return NextResponse.json({ ...projectMeetGreet(mg), candidates: projectCandidates(candidates) });
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
  const parsed = UpdateMeetGreetSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  const existing = await getMeetGreet(auth, id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    await updateMeetGreet(auth, id, parsed.data);
  } catch (e) {
    if (e instanceof MeetGreetInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
  const mg = await getMeetGreet(auth, id);
  if (!mg) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(projectMeetGreet(mg));
}
