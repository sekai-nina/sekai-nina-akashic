import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import {
  listEntities,
  searchEntities,
  findOrCreateEntity,
} from "@/lib/domain/entities";
import type { EntityType } from "@prisma/client";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  const type = (url.searchParams.get("type") as EntityType) || undefined;

  if (q) {
    const entities = await searchEntities(q, type);
    return NextResponse.json({ items: entities });
  }

  const page = Number(url.searchParams.get("page")) || 1;
  const perPage = Math.min(Number(url.searchParams.get("perPage")) || 20, 100);
  const result = await listEntities(type, page, perPage);
  return NextResponse.json(result);
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const body = await request.json();
  if (!body.type || !body.canonicalName) {
    return NextResponse.json(
      { error: "type and canonicalName are required" },
      { status: 400 }
    );
  }

  const entity = await findOrCreateEntity(body.type, body.canonicalName);
  return NextResponse.json(entity, { status: 201 });
}
