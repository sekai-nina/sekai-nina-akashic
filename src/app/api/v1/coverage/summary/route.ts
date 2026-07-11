import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getSummary } from "@/lib/domain/coverage";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const summary = await getSummary(auth.clearance);
  return NextResponse.json(summary);
}
