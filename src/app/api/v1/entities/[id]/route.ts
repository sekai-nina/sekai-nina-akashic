import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getEntityById } from "@/lib/domain/entities";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  // クリアランスで参照できない聖地エンティティは 404 にする
  const entity = await getEntityById(id, auth.clearance);

  if (!entity) {
    return NextResponse.json({ error: "Entity not found" }, { status: 404 });
  }

  return NextResponse.json(entity);
}
