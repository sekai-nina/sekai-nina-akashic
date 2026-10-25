import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { invalidateAssetList } from "@/lib/cache";
import { NinaAuthorConflictError, setNinaAppearance } from "@/lib/domain/nina-appearance";
import { NINA_APPEARANCES, isNinaAppearance } from "@/lib/nina";

/** 坂井新奈が出ているかを 出ている / 出ていない / 未確認 のどれかに置く (#261。Discord bot の ✅ / ❌) */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { status?: unknown } | null;
  if (!isNinaAppearance(body?.status)) {
    return NextResponse.json(
      { error: `status must be one of: ${NINA_APPEARANCES.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const result = await setNinaAppearance(id, body.status, auth.id, auth.clearance);
    if (!result) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    invalidateAssetList();
    return NextResponse.json({ id, ninaAppearance: result });
  } catch (err) {
    if (err instanceof NinaAuthorConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
