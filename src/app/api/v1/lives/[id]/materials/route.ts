import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { invalidateDossiers } from "@/lib/cache";
import { applyMaterials, getLive, LiveInputError } from "@/lib/domain/lives";
import { ApplyMaterialsSchema } from "@/lib/meetgreet/api";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ id: string }> };

/** チェック結果の反映。指定したアセットをドシエに asset_ref で入れる (同じものは 2 回入らない) */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = ApplyMaterialsSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  const live = await getLive(auth, id);
  if (!live) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const result = await applyMaterials(auth, live, parsed.data.assetIds);
    invalidateDossiers();
    return NextResponse.json({ added: result.added, skipped: result.skipped, dossierId: live.dossierId });
  } catch (e) {
    // 権限不足は 403、ドシエが消えていれば 404。それ以外 (DB エラー等) は 500
    if (e instanceof LiveInputError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    if (e instanceof Error && e.message.includes("Access denied")) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    throw e;
  }
}
