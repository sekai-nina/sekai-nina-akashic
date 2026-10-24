import { NextResponse } from "next/server";
import { TextType } from "@prisma/client";
import { requireApiAuth } from "@/lib/api-auth";
import { withClearance } from "@/lib/db";
import { addTextRevision, listTextRevisions } from "@/lib/domain/text-revisions";

/** 本文の版の一覧 (#262)。新しい順 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const asset = await withClearance(auth.clearance, (tx) =>
    tx.asset.findUnique({ where: { id }, select: { id: true } })
  );
  if (!asset) {
    return NextResponse.json({ error: "Asset not found" }, { status: 404 });
  }

  const revisions = await listTextRevisions(id, auth.clearance);
  return NextResponse.json({ revisions });
}

/**
 * 公式から取り直した本文を送る (#262)。現行と違えば新しい版として積み、AssetText を書き換える。
 * body: { content: string, textType?: "body" (既定) | TextType, fetchedAt?: ISO 8601 (既定は今) }
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { content, textType = "body", fetchedAt } = (body ?? {}) as {
    content?: unknown;
    textType?: unknown;
    fetchedAt?: unknown;
  };

  if (typeof content !== "string" || !content.trim()) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }
  if (typeof textType !== "string" || !Object.values(TextType).includes(textType as TextType)) {
    return NextResponse.json({ error: `Invalid textType: ${String(textType)}` }, { status: 400 });
  }
  let fetchedAtDate = new Date();
  if (fetchedAt !== undefined) {
    fetchedAtDate = new Date(typeof fetchedAt === "string" ? fetchedAt : NaN);
    if (Number.isNaN(fetchedAtDate.getTime())) {
      return NextResponse.json({ error: "fetchedAt must be an ISO 8601 string" }, { status: 400 });
    }
  }

  const result = await addTextRevision(
    { assetId: id, textType: textType as TextType, content, fetchedAt: fetchedAtDate },
    auth.clearance
  );
  if (!result) {
    return NextResponse.json({ error: "Asset not found" }, { status: 404 });
  }
  return NextResponse.json(result, { status: result.status === "unchanged" ? 200 : 201 });
}
