import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { withClearance } from "@/lib/db";
import { deleteAssetRelation } from "@/lib/domain/relations";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; relationId: string }> },
) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id, relationId } = await params;

  // Verify the relation exists and belongs to this asset
  const relation = await withClearance(auth.clearance, (tx) =>
    tx.assetRelation.findUnique({
      where: { id: relationId },
    })
  );
  if (!relation || (relation.sourceId !== id && relation.targetId !== id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await deleteAssetRelation(relationId, auth.id, auth.clearance);
  return NextResponse.json({ deleted: true });
}
