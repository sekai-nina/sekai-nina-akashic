import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireApiAuth } from "@/lib/api-auth";
import { updateDataSource } from "@/lib/domain/coverage";
import { CoverageInputError, CoverageNotFoundError, CoveragePermissionError } from "@/lib/coverage/collection";
import type { ClearanceLevel, DataSourceKind, ItemRule } from "@prisma/client";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "JSON オブジェクトを送ってください" }, { status: 400 });
  }
  if (body.collectedUntil !== undefined && body.collectedUntil !== null && typeof body.collectedUntil !== "string") {
    return NextResponse.json({ error: "collectedUntil は YYYY-MM-DD か null で指定してください" }, { status: 400 });
  }

  try {
    const source = await updateDataSource(
      id,
      {
        name: body.name,
        kind: body.kind as DataSourceKind | undefined,
        description: body.description,
        sortOrder: body.sortOrder,
        active: body.active,
        public: body.public,
        classification: body.classification as ClearanceLevel | undefined,
        itemRule: body.itemRule as ItemRule | undefined,
        publisherPattern: body.publisherPattern,
        titlePattern: body.titlePattern,
        // 手入力の収集済みの日付 (#253)。省略は保持、null は未確認に戻す
        collectedUntil: body.collectedUntil,
      },
      auth.clearance,
      auth.id
    );
    return NextResponse.json(source);
  } catch (e) {
    if (e instanceof CoverageNotFoundError
      || e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return NextResponse.json({ error: "データソースが見つかりません" }, { status: 404 });
    }
    if (e instanceof CoveragePermissionError) return NextResponse.json({ error: e.message }, { status: 403 });
    if (e instanceof CoverageInputError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
