import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { updateDataSource } from "@/lib/domain/coverage";
import type { ClearanceLevel, DataSourceKind, ItemRule } from "@prisma/client";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const body = await request.json();

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
      },
      auth.clearance,
      auth.id
    );
    return NextResponse.json(source);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
