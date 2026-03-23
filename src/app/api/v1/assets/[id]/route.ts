import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getAsset, updateAsset } from "@/lib/domain/assets";
import type { UpdateAssetData } from "@/lib/domain/assets";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const asset = await getAsset(id);
  if (!asset) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(asset);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const existing = await getAsset(id);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json() as UpdateAssetData;
  const asset = await updateAsset(id, body, auth.id);
  return NextResponse.json(asset);
}
