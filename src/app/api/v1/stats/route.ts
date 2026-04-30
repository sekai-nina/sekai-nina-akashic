import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getDashboardStats } from "@/lib/domain/stats";
import { getCachedNinaStatsRecent } from "@/lib/cache";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const [stats, recent] = await Promise.all([
    getDashboardStats(),
    getCachedNinaStatsRecent(),
  ]);

  return NextResponse.json({
    ...stats,
    recent,
  });
}
