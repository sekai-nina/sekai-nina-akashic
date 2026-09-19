import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getMeetGreet, MeetGreetInputError, selectSketch } from "@/lib/domain/meetgreets";
import { SelectSketchSchema, projectMeetGreet } from "@/lib/meetgreet/api";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ id: string }> };

/** 候補の 1 枚を確定する (記事のサムネになる) */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = SelectSketchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  const mg = await getMeetGreet(auth, id);
  if (!mg) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    await selectSketch(auth, mg, parsed.data.key);
  } catch (e) {
    if (e instanceof MeetGreetInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
  const updated = await getMeetGreet(auth, id);
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(projectMeetGreet(updated));
}
