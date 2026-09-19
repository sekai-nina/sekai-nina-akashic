import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { invalidateAnniversaries } from "@/lib/cache";
import {
  AnniversaryInputError,
  ANNIVERSARY_TOTAL_DAYS,
  countFilledDays,
  createAnniversary,
  listAnniversaries,
} from "@/lib/domain/anniversaries";
import { CreateAnniversarySchema, projectAnniversary } from "@/lib/anniversaries/api";
import { formatZodError } from "@/lib/zod-error";

/** 月日順の全件。公開サイトがビルド時に読む */
export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const rows = await listAnniversaries(auth.clearance);
  return NextResponse.json({
    items: rows.map(projectAnniversary),
    filledDays: countFilledDays(rows),
    totalDays: ANNIVERSARY_TOTAL_DAYS,
  });
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = CreateAnniversarySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  try {
    const row = await createAnniversary(parsed.data, auth.clearance, auth.id);
    invalidateAnniversaries();
    return NextResponse.json(projectAnniversary(row), { status: 201 });
  } catch (e) {
    if (e instanceof AnniversaryInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    if (e instanceof Error && e.message.includes("Access denied")) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    throw e;
  }
}
