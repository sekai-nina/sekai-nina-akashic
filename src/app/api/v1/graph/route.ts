import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/db";
import { getAssetGraph } from "@/lib/domain/relations";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const assetId = url.searchParams.get("assetId");
  const depth = Math.min(parseInt(url.searchParams.get("depth") ?? "2", 10) || 2, 4);

  if (!assetId) {
    return NextResponse.json(
      { error: "assetId is required" },
      { status: 400 },
    );
  }

  const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { id: true } });
  if (!asset) {
    return NextResponse.json({ error: "Asset not found" }, { status: 404 });
  }

  const graph = await getAssetGraph(assetId, depth);
  return NextResponse.json(graph);
}
