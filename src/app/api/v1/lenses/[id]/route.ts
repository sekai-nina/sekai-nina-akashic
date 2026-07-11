import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { updateLens } from "@/lib/domain/coverage";
import type { ClearanceLevel } from "@prisma/client";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const body = await request.json();

  try {
    const lens = await updateLens(
      id,
      {
        name: body.name,
        description: body.description,
        sortOrder: body.sortOrder,
        active: body.active,
        public: body.public,
        classification: body.classification as ClearanceLevel | undefined,
      },
      auth.clearance,
      auth.id
    );
    return NextResponse.json(lens);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
