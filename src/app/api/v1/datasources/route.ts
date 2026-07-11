import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { listDataSources, createDataSource } from "@/lib/domain/coverage";
import type { ClearanceLevel, DataSourceKind } from "@prisma/client";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const sources = await listDataSources(auth.clearance);
  return NextResponse.json(sources);
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const body = await request.json();
  if (!body.key || !body.name || !body.kind) {
    return NextResponse.json(
      { error: "key, name, and kind are required" },
      { status: 400 }
    );
  }

  try {
    const source = await createDataSource(
      {
        key: body.key,
        name: body.name,
        kind: body.kind as DataSourceKind,
        description: body.description,
        sortOrder: body.sortOrder,
        public: body.public,
        classification: body.classification as ClearanceLevel | undefined,
      },
      auth.clearance,
      auth.id
    );
    return NextResponse.json(source, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
