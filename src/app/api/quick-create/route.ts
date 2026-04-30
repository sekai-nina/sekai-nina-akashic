import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/domain/audit";
import { invalidateAssets } from "@/lib/cache";
import { findOrCreateEntity } from "@/lib/domain/entities";
import { addEntityToAsset } from "@/lib/domain/entities";
import { normalizeText } from "@/lib/utils";
import { NextResponse } from "next/server";
import type { AssetKind } from "@prisma/client";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const title = (formData.get("title") as string) || "";
  const kind = (formData.get("kind") as AssetKind) || "other";
  const canonicalDate = formData.get("canonicalDate") as string | null;
  const bodyText = formData.get("bodyText") as string | null;
  const entitiesRaw = formData.get("entities") as string | null;
  const textsRaw = formData.get("texts") as string | null;

  const asset = await prisma.asset.create({
    data: {
      kind,
      title,
      status: "inbox",
      sourceType: "manual",
      canonicalDate: canonicalDate ? new Date(canonicalDate) : null,
      createdById: session.user.id,
      updatedById: session.user.id,
    },
  });

  // Add body text if provided
  if (bodyText?.trim()) {
    await prisma.assetText.create({
      data: {
        assetId: asset.id,
        textType: "body",
        content: bodyText.trim(),
        normalizedContent: normalizeText(bodyText.trim()),
        createdById: session.user.id,
      },
    });
  }

  // Add texts from JSON if provided
  if (textsRaw) {
    try {
      const texts = JSON.parse(textsRaw) as Array<{ textType: string; content: string }>;
      for (const t of texts) {
        if (t.content?.trim()) {
          await prisma.assetText.create({
            data: {
              assetId: asset.id,
              textType: t.textType as "body",
              content: t.content.trim(),
              normalizedContent: normalizeText(t.content.trim()),
              createdById: session.user.id,
            },
          });
        }
      }
    } catch { /* ignore parse errors */ }
  }

  // Link entities/tags
  if (entitiesRaw) {
    try {
      const entities = JSON.parse(entitiesRaw) as Array<{ type: string; canonicalName: string }>;
      for (const e of entities) {
        const entity = await findOrCreateEntity(e.type as "tag", e.canonicalName);
        await addEntityToAsset(asset.id, entity.id);
      }
    } catch { /* ignore parse errors */ }
  }

  await logAudit({
    actorId: session.user.id,
    action: "asset.create",
    targetType: "Asset",
    targetId: asset.id,
  });

  invalidateAssets();

  return NextResponse.json({ id: asset.id });
}
