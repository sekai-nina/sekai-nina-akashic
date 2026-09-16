import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { listPlaces, createPlace } from "@/lib/domain/places";
import { invalidatePlaces } from "@/lib/cache";
import type { ClearanceLevel } from "@prisma/client";
import { parsePlaceKind } from "@/lib/places/kind";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const places = await listPlaces(auth.clearance);

  const result = places.map((p) => ({
    id: p.id,
    entityId: p.entityId,
    name: p.entity.canonicalName,
    description: p.entity.description,
    latitude: p.latitude,
    longitude: p.longitude,
    googleMapsUrl: p.googleMapsUrl,
    address: p.address,
    kind: p.kind,
    area: p.area,
    classification: p.classification,
    assetCount: p.entity._count.assets,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));

  return NextResponse.json(result);
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const body = await request.json();
  if (!body.name || body.latitude == null || body.longitude == null) {
    return NextResponse.json(
      { error: "name, latitude, and longitude are required" },
      { status: 400 }
    );
  }
  const kind = parsePlaceKind(body.kind);
  if (kind === false) {
    return NextResponse.json({ error: "kind must be one of food, leisure, scenery, venue, shop" }, { status: 400 });
  }
  if (body.area !== undefined && body.area !== null && typeof body.area !== "string") {
    return NextResponse.json({ error: "area must be a string" }, { status: 400 });
  }

  const place = await createPlace(
    {
      canonicalName: body.name,
      latitude: body.latitude,
      longitude: body.longitude,
      googleMapsUrl: body.googleMapsUrl,
      address: body.address,
      description: body.description,
      aliases: body.aliases,
      kind,
      area: body.area,
      classification: body.classification as ClearanceLevel | undefined,
    },
    auth.clearance
  );

  invalidatePlaces();

  return NextResponse.json(
    {
      id: place.id,
      entityId: place.entityId,
      name: place.entity.canonicalName,
      latitude: place.latitude,
      longitude: place.longitude,
      googleMapsUrl: place.googleMapsUrl,
      address: place.address,
      kind: place.kind,
      area: place.area,
      classification: place.classification,
      assetCount: place.entity._count.assets,
    },
    { status: 201 }
  );
}
