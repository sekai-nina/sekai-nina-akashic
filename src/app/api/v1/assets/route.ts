import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { listAssets } from "@/lib/domain/assets";
import { intakeAsset, type AssetIntakeData } from "@/lib/domain/asset-intake";
import { assertClearance } from "@/lib/classification";
import type { ListAssetsFilters } from "@/lib/domain/assets";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const includeParam = url.searchParams.get("include");
  const updatedSinceParam = url.searchParams.get("updatedSince");
  const filters: ListAssetsFilters = {
    status: (url.searchParams.get("status") as ListAssetsFilters["status"]) || undefined,
    kind: (url.searchParams.get("kind") as ListAssetsFilters["kind"]) || undefined,
    trustLevel: (url.searchParams.get("trustLevel") as ListAssetsFilters["trustLevel"]) || undefined,
    sourceType: (url.searchParams.get("sourceType") as ListAssetsFilters["sourceType"]) || undefined,
    updatedSince: updatedSinceParam ? new Date(updatedSinceParam) : undefined,
    entityId: url.searchParams.get("entityId") || undefined,
    page: Number(url.searchParams.get("page")) || 1,
    perPage: Math.min(Number(url.searchParams.get("perPage")) || 20, 100),
    include: includeParam ? includeParam.split(",") : undefined,
  };

  const result = await listAssets(filters, auth.clearance);
  return NextResponse.json(result);
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const body = (await request.json()) as AssetIntakeData;

  if (!body.kind) {
    return NextResponse.json({ error: "kind is required" }, { status: 400 });
  }

  // クリアランス超過は intakeAsset の中でも弾かれるが、ここで 403 に整形しておく
  // (`||` は intakeAsset 側の既定値の入れ方に合わせている。空文字は internal 扱い)
  try {
    assertClearance(auth.clearance, body.classification || "internal");
  } catch {
    return NextResponse.json(
      { error: "Cannot create asset with classification above your clearance" },
      { status: 403 },
    );
  }

  const asset = await intakeAsset(body, auth.id, auth.clearance);

  return NextResponse.json(asset, { status: 201 });
}
