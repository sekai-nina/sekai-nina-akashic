import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getPlaceById, updatePlace, deletePlace } from "@/lib/domain/places";
import { invalidatePlaces } from "@/lib/cache";
import type { ClearanceLevel } from "@prisma/client";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const place = await getPlaceById(id, auth.clearance);
  if (!place) {
    return NextResponse.json({ error: "Place not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: place.id,
    entityId: place.entityId,
    name: place.entity.canonicalName,
    description: place.entity.description,
    latitude: place.latitude,
    longitude: place.longitude,
    googleMapsUrl: place.googleMapsUrl,
    address: place.address,
    classification: place.classification,
    assetCount: place.entity._count.assets,
    createdAt: place.createdAt,
    updatedAt: place.updatedAt,
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const body = await request.json();

  // このルートには元々 assertClearance が無く、上位機密の付与を RLS の WITH CHECK
  // だけが止めていた。API キーは MCP と共通なので、アプリ層でも引き上げ/引き下げを検査する。
  if (body.classification) {
    const { assertClearance, isClassificationDowngrade } = await import("@/lib/classification");
    try {
      assertClearance(auth.clearance, body.classification);
    } catch {
      return NextResponse.json(
        { error: "Cannot set classification above your clearance level" },
        { status: 403 }
      );
    }

    const current = await getPlaceById(id, auth.clearance);
    if (!current) {
      return NextResponse.json({ error: "Place not found" }, { status: 404 });
    }
    if (isClassificationDowngrade(current.classification, body.classification)) {
      return NextResponse.json(
        {
          error: `Cannot lower classification (${current.classification} -> ${body.classification}) via API key`,
        },
        { status: 403 }
      );
    }
  }

  const place = await updatePlace(
    id,
    {
      canonicalName: body.name,
      latitude: body.latitude,
      longitude: body.longitude,
      googleMapsUrl: body.googleMapsUrl,
      address: body.address,
      description: body.description,
      classification: body.classification as ClearanceLevel | undefined,
    },
    auth.clearance
  );

  invalidatePlaces();

  return NextResponse.json({
    id: place.id,
    entityId: place.entityId,
    name: place.entity.canonicalName,
    latitude: place.latitude,
    longitude: place.longitude,
    googleMapsUrl: place.googleMapsUrl,
    address: place.address,
    classification: place.classification,
    assetCount: place.entity._count.assets,
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  await deletePlace(id, auth.clearance);
  invalidatePlaces();

  return NextResponse.json({ success: true });
}
