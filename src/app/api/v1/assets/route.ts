import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { createAsset, listAssets } from "@/lib/domain/assets";
import type { CreateAssetData, ListAssetsFilters } from "@/lib/domain/assets";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const filters: ListAssetsFilters = {
    status: (url.searchParams.get("status") as ListAssetsFilters["status"]) || undefined,
    kind: (url.searchParams.get("kind") as ListAssetsFilters["kind"]) || undefined,
    trustLevel: (url.searchParams.get("trustLevel") as ListAssetsFilters["trustLevel"]) || undefined,
    sourceType: (url.searchParams.get("sourceType") as ListAssetsFilters["sourceType"]) || undefined,
    page: Number(url.searchParams.get("page")) || 1,
    perPage: Math.min(Number(url.searchParams.get("perPage")) || 20, 100),
  };

  const result = await listAssets(filters);
  return NextResponse.json(result);
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const body = await request.json() as CreateAssetData;

  if (!body.kind) {
    return NextResponse.json({ error: "kind is required" }, { status: 400 });
  }

  const asset = await createAsset(body, auth.id);
  return NextResponse.json(asset, { status: 201 });
}
