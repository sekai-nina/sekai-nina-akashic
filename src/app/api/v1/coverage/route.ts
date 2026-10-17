import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getMatrix, upsertCell } from "@/lib/domain/coverage";
import { CoverageInputError, CoveragePermissionError } from "@/lib/coverage/freshness";
import { z } from "zod";

const cellSchema = z.object({
  lensKey: z.string().min(1).max(128), dataSourceKey: z.string().min(1).max(128),
  status: z.enum(["tracked", "not_applicable"]).optional(), confirmedUntil: z.string().nullable().optional(),
  note: z.string().max(10000).nullable().optional(),
  classification: z.enum(["public", "internal", "confidential", "restricted"]).optional(),
});

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const publicOnly = url.searchParams.get("public") === "1";

  const matrix = await getMatrix(auth.clearance, { publicOnly });
  return NextResponse.json(matrix);
}

export async function PUT(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const parsed = cellSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "入力を確認してください" }, { status: 400 });
  try {
    const cell = await upsertCell(parsed.data, auth.clearance, auth.id);
    return NextResponse.json(cell);
  } catch (e) {
    if (e instanceof CoverageInputError) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof CoveragePermissionError) return NextResponse.json({ error: e.message }, { status: 403 });
    return NextResponse.json({ error: "鮮度日付を更新できませんでした" }, { status: 400 });
  }
}
