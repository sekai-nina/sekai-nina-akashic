import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getWordFrequencies } from "@/lib/domain/wordcloud";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 300);

  // since / period: 期間フィルタ（3m, 1y, all, または ISO日付文字列）
  const sinceParam = url.searchParams.get("since") ?? url.searchParams.get("period");
  let since: Date | undefined;
  if (sinceParam) {
    const now = new Date();
    if (sinceParam === "3m") {
      since = new Date(now);
      since.setMonth(since.getMonth() - 3);
    } else if (sinceParam === "1y") {
      since = new Date(now);
      since.setFullYear(since.getFullYear() - 1);
    } else {
      const parsed = new Date(sinceParam);
      if (!isNaN(parsed.getTime())) since = parsed;
    }
  }

  const words = await getWordFrequencies(limit, since);
  return NextResponse.json({ words });
}
