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
