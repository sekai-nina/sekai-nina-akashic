import { NextResponse } from "next/server";
import sharp from "sharp";
import { auth } from "@/lib/auth";
import { withSession } from "@/lib/db";
import { uploadToR2, isR2Configured } from "@/lib/r2";
import { canEditDossier } from "@/lib/auth/dossier-permissions";
import { invalidateDossiers } from "@/lib/cache";
import { logAudit } from "@/lib/domain/audit";

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  if (!isR2Configured()) {
    return NextResponse.json({ error: "R2 is not configured on this deployment" }, { status: 503 });
  }

  const { id: dossierId } = await params;

  // Authorize against the dossier — does the user have edit access?
  const access = await withSession(session.user, (tx) =>
    tx.dossier.findUnique({
      where: { id: dossierId },
      select: { ownerId: true, classification: true, viewMode: true, editMode: true },
    })
  );
  if (!access) {
    return NextResponse.json({ error: "Dossier not found" }, { status: 404 });
  }
  if (!canEditDossier(session.user, access)) {
    return NextResponse.json({ error: "Insufficient permission" }, { status: 403 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const caption = (formData.get("caption") as string) || "";
  const note = (formData.get("note") as string) || "";

  if (!file) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: "File must be an image" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File too large" }, { status: 413 });
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Normalize EXIF rotation, then re-encode to a lightweight 640px WebP.
  // We intentionally do NOT keep the full-resolution original — this single
  // image doubles as both the list thumbnail and the click-through view,
  // matching the blog/talk thumbnail pipeline (640px WebP, quality 80).
  const image = await sharp(buffer)
    .rotate()
    .resize(640, null, { withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();

  // Create the row first so we have a stable id, then upload R2 objects to a
  // key prefixed by it. If R2 fails we delete the row to keep things clean.
  const item = await withSession(session.user, async (tx) => {
    const last = await tx.dossierItem.findFirst({
      where: { dossierId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    return tx.dossierItem.create({
      data: {
        dossierId,
        kind: "external_image",
        caption,
        note,
        sortOrder: (last?.sortOrder ?? -1) + 1,
      },
    });
  });

  const imageKey = `dossiers/${dossierId}/${item.id}/image.webp`;

  try {
    await uploadToR2(imageKey, image, "image/webp");

    await withSession(session.user, (tx) =>
      tx.dossierItem.update({
        where: { id: item.id },
        data: {
          externalImageKey: imageKey,
          externalImageThumbKey: imageKey,
        },
      })
    );
  } catch (err) {
    // Roll back the row on upload failure
    await withSession(session.user, (tx) =>
      tx.dossierItem.delete({ where: { id: item.id } })
    );
    console.error("Failed to upload external image:", err);
    return NextResponse.json({ error: "Failed to upload image" }, { status: 500 });
  }

  await logAudit({
    actorId: session.user.id,
    action: "dossier.item.add",
    targetType: "DossierItem",
    targetId: item.id,
    metadata: { dossierId, kind: "external_image" },
  });

  invalidateDossiers();

  return NextResponse.json({
    id: item.id,
    externalImageKey: imageKey,
    externalImageThumbKey: imageKey,
  });
}
