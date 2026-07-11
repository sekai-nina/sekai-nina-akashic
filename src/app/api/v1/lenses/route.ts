import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { listLenses, createLens } from "@/lib/domain/coverage";
import type { ClearanceLevel } from "@prisma/client";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const lenses = await listLenses(auth.clearance);
  return NextResponse.json(lenses);
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const body = await request.json();
  if (!body.key || !body.name) {
    return NextResponse.json({ error: "key and name are required" }, { status: 400 });
  }

  try {
    const lens = await createLens(
      {
        key: body.key,
        name: body.name,
        description: body.description,
        sortOrder: body.sortOrder,
        public: body.public,
        classification: body.classification as ClearanceLevel | undefined,
      },
      auth.clearance,
      auth.id
    );
    return NextResponse.json(lens, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
