import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { withClearance } from "@/lib/db";
import { RelationType } from "@prisma/client";
import {
  createAssetRelation,
  getAssetRelations,
} from "@/lib/domain/relations";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  // RLS handles classification filtering: if asset is not accessible, findUnique returns null
  const asset = await withClearance(auth.clearance, (tx) =>
    tx.asset.findUnique({ where: { id }, select: { id: true } })
  );
  if (!asset) {
    return NextResponse.json({ error: "Asset not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const relationType = url.searchParams.get("relationType") as RelationType | null;

  const relations = await getAssetRelations(id, auth.clearance);

  if (relationType) {
    return NextResponse.json({
      asSource: relations.asSource.filter((r) => r.relationType === relationType),
      asTarget: relations.asTarget.filter((r) => r.relationType === relationType),
    });
  }

  return NextResponse.json(relations);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const body = await request.json();

  const { targetId, relationType, metadata, sortOrder } = body as {
    targetId: string;
    relationType: RelationType;
    metadata?: Record<string, unknown>;
    sortOrder?: number;
  };

  if (!targetId || !relationType) {
    return NextResponse.json(
      { error: "targetId and relationType are required" },
      { status: 400 },
    );
  }

  if (!Object.values(RelationType).includes(relationType)) {
    return NextResponse.json(
      { error: `Invalid relationType: ${relationType}` },
      { status: 400 },
    );
  }

  try {
    const relation = await createAssetRelation(
      { sourceId: id, targetId, relationType, metadata, sortOrder },
      auth.id,
      auth.clearance,
    );
    return NextResponse.json(relation, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status = message.includes("not found") ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
