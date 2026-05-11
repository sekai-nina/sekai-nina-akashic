import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getAsset, updateAsset, deleteAsset } from "@/lib/domain/assets";
import type { UpdateAssetData } from "@/lib/domain/assets";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  try {
    const asset = await getAsset(id, auth.clearance);
    if (!asset) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(asset);
  } catch (err) {
    if (err instanceof Error && err.message.includes("Access denied")) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  try {
    const existing = await getAsset(id, auth.clearance);
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("Access denied")) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  const body = await request.json() as UpdateAssetData;

  // Prevent classification escalation above user's clearance
  if (body.classification) {
    const { assertClearance } = await import("@/lib/classification");
    try {
      assertClearance(auth.clearance, body.classification);
    } catch {
      return NextResponse.json({ error: "Cannot set classification above your clearance level" }, { status: 403 });
    }
  }

  const asset = await updateAsset(id, body, auth.id, auth.clearance);
  return NextResponse.json(asset);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  try {
    const existing = await getAsset(id, auth.clearance);
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("Access denied")) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  await deleteAsset(id, auth.id, auth.clearance);
  return NextResponse.json({ deleted: true });
}
