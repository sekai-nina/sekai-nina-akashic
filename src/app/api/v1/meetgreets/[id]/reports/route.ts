import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getMeetGreet, refetchReports } from "@/lib/domain/meetgreets";

type Params = { params: Promise<{ id: string }> };

/** X レポの再収集。keep / total は GET /meetgreets/:id で読む */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const mg = await getMeetGreet(auth, id);
  if (!mg) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const outcome = await refetchReports(auth, mg);
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: 502 });
  return NextResponse.json(outcome.result);
}
