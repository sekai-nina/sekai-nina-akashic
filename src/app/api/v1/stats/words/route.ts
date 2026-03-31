import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getWordFrequencies } from "@/lib/domain/wordcloud";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 300);

  const words = await getWordFrequencies(limit);
  return NextResponse.json({ words });
}
