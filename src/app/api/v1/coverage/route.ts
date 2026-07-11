import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getMatrix, upsertCell } from "@/lib/domain/coverage";
import type { ClearanceLevel, CoverageStatus } from "@prisma/client";

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

  const body = await request.json();
  if (!body.lensKey || !body.dataSourceKey) {
    return NextResponse.json(
      { error: "lensKey and dataSourceKey are required" },
      { status: 400 }
    );
  }

  try {
    const cell = await upsertCell(
      {
        lensKey: body.lensKey,
        dataSourceKey: body.dataSourceKey,
        status: body.status as CoverageStatus | undefined,
        note: body.note,
        classification: body.classification as ClearanceLevel | undefined,
      },
      auth.clearance,
      auth.id
    );
    return NextResponse.json(cell);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
