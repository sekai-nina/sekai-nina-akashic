import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { listDossiers } from "@/lib/domain/dossiers";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const dossiers = await listDossiers(auth);

  return NextResponse.json({
    items: dossiers.map((d) => ({
      id: d.id,
      title: d.title,
      summary: d.summary,
      classification: d.classification,
      viewMode: d.viewMode,
      editMode: d.editMode,
      owner: d.owner,
      itemCount: d._count.items,
      placeCandidateCount: d._count.placeCandidates,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    })),
  });
}
