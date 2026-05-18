import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getDossierForApi } from "@/lib/domain/dossiers";
import { canViewDossier } from "@/lib/auth/dossier-permissions";

const R2_PUBLIC_URL = (
  process.env.R2_PUBLIC_URL ||
  process.env.NEXT_PUBLIC_R2_PUBLIC_URL ||
  ""
).replace(/\/$/, "");

function r2Url(key: string | null): string | null {
  if (!key || !R2_PUBLIC_URL) return null;
  return `${R2_PUBLIC_URL}/${key}`;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const dossier = await getDossierForApi(auth, id);
  if (!dossier) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!canViewDossier(auth, dossier)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({
    id: dossier.id,
    title: dossier.title,
    summary: dossier.summary,
    classification: dossier.classification,
    viewMode: dossier.viewMode,
    editMode: dossier.editMode,
    createdAt: dossier.createdAt,
    updatedAt: dossier.updatedAt,
    owner: dossier.owner,
    items: dossier.items.map((item) => {
      const asset = item.asset;
      return {
        id: item.id,
        kind: item.kind,
        caption: item.caption,
        note: item.note,
        excerpt: item.excerpt || null,
        excerptType: item.excerptType,
        excerptStart: item.excerptStart,
        excerptEnd: item.excerptEnd,
        sortOrder: item.sortOrder,
        externalUrl: item.externalUrl,
        externalImageUrl: r2Url(item.externalImageKey),
        externalImageThumbnailUrl: r2Url(item.externalImageThumbKey),
        asset: asset
          ? {
              id: asset.id,
              kind: asset.kind,
              title: asset.title,
              description: asset.description,
              canonicalDate: asset.canonicalDate,
              thumbnailUrl: asset.thumbnailUrl,
              storageUrl: asset.storageUrl,
              classification: asset.classification,
              texts: asset.texts.map((t) => ({
                textType: t.textType,
                content: t.content,
              })),
              sources: asset.sourceRecords.map((s) => ({
                kind: s.sourceKind,
                title: s.title,
                url: s.url,
                publisher: s.publisher,
                publishedAt: s.publishedAt,
              })),
              entities: asset.entities.map((ae) => ({
                type: ae.entity.type,
                name: ae.entity.canonicalName,
                roleLabel: ae.roleLabel,
              })),
            }
          : null,
      };
    }),
    placeCandidates: dossier.placeCandidates.map((pc) => ({
      id: pc.id,
      name: pc.place?.entity.canonicalName ?? pc.name,
      address: pc.address,
      latitude: pc.latitude,
      longitude: pc.longitude,
      googleMapsUrl: pc.googleMapsUrl,
      note: pc.note,
      confidence: pc.confidence,
      promoted: pc.place != null,
      placeId: pc.placeId,
      placeStatus: pc.place?.status ?? null,
    })),
  });
}
