import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getDashboardStats } from "@/lib/domain/stats";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const stats = await getDashboardStats();
  return NextResponse.json(stats);
}
