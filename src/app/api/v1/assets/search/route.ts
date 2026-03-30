import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { search } from "@/lib/search";
import type { SearchQuery } from "@/lib/search";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";

  const query: SearchQuery = {
    q,
    target: (url.searchParams.get("target") as SearchQuery["target"]) || "all",
    kind: (url.searchParams.get("kind") as SearchQuery["kind"]) || undefined,
    status: (url.searchParams.get("status") as SearchQuery["status"]) || undefined,
    trustLevel: (url.searchParams.get("trustLevel") as SearchQuery["trustLevel"]) || undefined,
    sourceType: (url.searchParams.get("sourceType") as SearchQuery["sourceType"]) || undefined,
    entityId: url.searchParams.get("entityId") || undefined,
    entityIds: url.searchParams.get("entityIds")
      ? url.searchParams.get("entityIds")!.split(",").filter(Boolean)
      : undefined,
    dateFrom: url.searchParams.get("dateFrom") ? new Date(url.searchParams.get("dateFrom")!) : undefined,
    dateTo: url.searchParams.get("dateTo") ? new Date(url.searchParams.get("dateTo")!) : undefined,
    page: Number(url.searchParams.get("page")) || 1,
    perPage: Math.min(Number(url.searchParams.get("perPage")) || 20, 100),
  };

  const result = await search(query);
  return NextResponse.json(result);
}
