import type {
  ClearanceLevel,
  DossierAccessMode,
  DossierItemKind,
  TextType,
} from "@prisma/client";
import { withSession } from "@/lib/db";
import { canEditDossier, canManageDossier } from "@/lib/auth/dossier-permissions";
import { logAudit } from "./audit";

interface ActingUser {
  id: string;
  role: string;
  clearance: string;
}

export interface CreateDossierInput {
  title: string;
  summary?: string;
  classification?: ClearanceLevel;
  viewMode?: DossierAccessMode;
  editMode?: DossierAccessMode;
}

export interface UpdateDossierInput {
  title?: string;
  summary?: string;
  classification?: ClearanceLevel;
  viewMode?: DossierAccessMode;
  editMode?: DossierAccessMode;
}

export async function listDossiers(user: ActingUser) {
  return withSession(user, (tx) =>
    tx.dossier.findMany({
      orderBy: { updatedAt: "desc" },
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true } },
        _count: { select: { items: true, placeCandidates: true } },
      },
    })
  );
}

/**
 * List dossiers the user can EDIT (owner OR editMode='clearance' & clearance meets classification).
 * Used to populate the AddToDossier picker.
 */
export async function listEditableDossiers(user: ActingUser) {
  const all = await withSession(user, (tx) =>
    tx.dossier.findMany({
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        ownerId: true,
        classification: true,
        viewMode: true,
        editMode: true,
      },
    })
  );
  return all.filter((d) => canEditDossier(user, d));
}

export async function getDossier(user: ActingUser, id: string) {
  return withSession(user, (tx) =>
    tx.dossier.findUnique({
      where: { id },
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true } },
        items: {
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          include: {
            asset: {
              select: {
                id: true,
                kind: true,
                title: true,
                canonicalDate: true,
                thumbnailUrl: true,
                storageProvider: true,
                storageUrl: true,
                classification: true,
              },
            },
          },
        },
        placeCandidates: {
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          include: {
            place: { include: { entity: true } },
          },
        },
      },
    })
  );
}

/**
 * Fetch a dossier with full content for API/AI consumption.
 * Includes asset texts and source records so the consumer can synthesize prose
 * without follow-up queries.
 */
export async function getDossierForApi(user: ActingUser, id: string) {
  return withSession(user, (tx) =>
    tx.dossier.findUnique({
      where: { id },
      include: {
        owner: { select: { id: true, name: true } },
        items: {
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          include: {
            asset: {
              select: {
                id: true,
                kind: true,
                title: true,
                description: true,
                canonicalDate: true,
                thumbnailUrl: true,
                storageProvider: true,
                storageUrl: true,
                storageKey: true,
                classification: true,
                texts: {
                  orderBy: { createdAt: "asc" },
                  select: { textType: true, content: true },
                },
                sourceRecords: {
                  orderBy: { createdAt: "asc" },
                  select: {
                    sourceKind: true,
                    title: true,
                    url: true,
                    publisher: true,
                    publishedAt: true,
                  },
                },
                entities: {
                  select: {
                    roleLabel: true,
                    entity: { select: { type: true, canonicalName: true } },
                  },
                },
              },
            },
          },
        },
        placeCandidates: {
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          include: {
            place: {
              include: { entity: { select: { canonicalName: true } } },
            },
          },
        },
      },
    })
  );
}

export async function createDossier(user: ActingUser, input: CreateDossierInput) {
  const dossier = await withSession(user, (tx) =>
    tx.dossier.create({
      data: {
        ownerId: user.id,
        title: input.title,
        summary: input.summary ?? "",
        classification: input.classification ?? "internal",
        viewMode: input.viewMode ?? "private",
        editMode: input.editMode ?? "private",
      },
    })
  );
  await logAudit({
    actorId: user.id,
    action: "dossier.create",
    targetType: "Dossier",
    targetId: dossier.id,
    metadata: { title: dossier.title },
  });
  return dossier;
}

async function loadAccessFields(user: ActingUser, id: string) {
  return withSession(user, (tx) =>
    tx.dossier.findUnique({
      where: { id },
      select: { ownerId: true, classification: true, viewMode: true, editMode: true },
    })
  );
}

export async function updateDossier(user: ActingUser, id: string, input: UpdateDossierInput) {
  const access = await loadAccessFields(user, id);
  if (!access) throw new Error("Dossier not found");
  const isOwner = canManageDossier(user, access);
  const aclChanging =
    input.classification !== undefined ||
    input.viewMode !== undefined ||
    input.editMode !== undefined;
  if (aclChanging && !isOwner) {
    throw new Error("Only the owner can change sharing settings");
  }
  if (!canEditDossier(user, access)) {
    throw new Error("Insufficient permission to edit this dossier");
  }

  const dossier = await withSession(user, (tx) =>
    tx.dossier.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.classification !== undefined ? { classification: input.classification } : {}),
        ...(input.viewMode !== undefined ? { viewMode: input.viewMode } : {}),
        ...(input.editMode !== undefined ? { editMode: input.editMode } : {}),
      },
    })
  );

  await logAudit({
    actorId: user.id,
    action: "dossier.update",
    targetType: "Dossier",
    targetId: id,
    metadata: input as unknown as Record<string, unknown>,
  });

  return dossier;
}

export async function deleteDossier(user: ActingUser, id: string) {
  const access = await loadAccessFields(user, id);
  if (!access) throw new Error("Dossier not found");
  if (!canManageDossier(user, access)) {
    throw new Error("Only the owner can delete a dossier");
  }
  await withSession(user, (tx) => tx.dossier.delete({ where: { id } }));
  await logAudit({
    actorId: user.id,
    action: "dossier.delete",
    targetType: "Dossier",
    targetId: id,
  });
}

// ============================================================
// Items
// ============================================================

async function requireEditAccess(user: ActingUser, dossierId: string) {
  const access = await loadAccessFields(user, dossierId);
  if (!access) throw new Error("Dossier not found");
  if (!canEditDossier(user, access)) {
    throw new Error("Insufficient permission to edit this dossier");
  }
  return access;
}

async function nextSortOrder(
  tx: Parameters<Parameters<typeof withSession>[1]>[0],
  dossierId: string
): Promise<number> {
  const last = await tx.dossierItem.findFirst({
    where: { dossierId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  return (last?.sortOrder ?? -1) + 1;
}

export interface AddAssetItemInput {
  assetId: string;
  caption?: string;
  note?: string;
  excerpt?: string;
  excerptType?: TextType;
  excerptStart?: number;
  excerptEnd?: number;
}

export async function addAssetItem(user: ActingUser, dossierId: string, input: AddAssetItemInput) {
  await requireEditAccess(user, dossierId);

  const item = await withSession(user, async (tx) => {
    const sortOrder = await nextSortOrder(tx, dossierId);
    return tx.dossierItem.upsert({
      where: {
        dossierId_assetId: { dossierId, assetId: input.assetId },
      },
      create: {
        dossierId,
        kind: "asset_ref",
        assetId: input.assetId,
        caption: input.caption ?? "",
        note: input.note ?? "",
        excerpt: input.excerpt ?? "",
        excerptType: input.excerptType ?? null,
        excerptStart: input.excerptStart ?? null,
        excerptEnd: input.excerptEnd ?? null,
        sortOrder,
      },
      update: {
        ...(input.caption !== undefined ? { caption: input.caption } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
        ...(input.excerptType !== undefined ? { excerptType: input.excerptType } : {}),
        ...(input.excerptStart !== undefined ? { excerptStart: input.excerptStart } : {}),
        ...(input.excerptEnd !== undefined ? { excerptEnd: input.excerptEnd } : {}),
      },
    });
  });

  await logAudit({
    actorId: user.id,
    action: "dossier.item.add",
    targetType: "DossierItem",
    targetId: item.id,
    metadata: { dossierId, assetId: input.assetId },
  });
  return item;
}

export interface AddExternalLinkInput {
  url: string;
  caption?: string;
  note?: string;
}

export async function addExternalLinkItem(
  user: ActingUser,
  dossierId: string,
  input: AddExternalLinkInput
) {
  await requireEditAccess(user, dossierId);

  const item = await withSession(user, async (tx) => {
    const sortOrder = await nextSortOrder(tx, dossierId);
    return tx.dossierItem.create({
      data: {
        dossierId,
        kind: "external_link",
        externalUrl: input.url,
        caption: input.caption ?? "",
        note: input.note ?? "",
        sortOrder,
      },
    });
  });
  await logAudit({
    actorId: user.id,
    action: "dossier.item.add",
    targetType: "DossierItem",
    targetId: item.id,
    metadata: { dossierId, kind: "external_link" },
  });
  return item;
}

export interface AddExternalImageInput {
  imageKey: string;
  thumbKey?: string | null;
  caption?: string;
  note?: string;
}

export async function addExternalImageItem(
  user: ActingUser,
  dossierId: string,
  input: AddExternalImageInput
) {
  await requireEditAccess(user, dossierId);

  const item = await withSession(user, async (tx) => {
    const sortOrder = await nextSortOrder(tx, dossierId);
    return tx.dossierItem.create({
      data: {
        dossierId,
        kind: "external_image",
        externalImageKey: input.imageKey,
        externalImageThumbKey: input.thumbKey ?? null,
        caption: input.caption ?? "",
        note: input.note ?? "",
        sortOrder,
      },
    });
  });
  await logAudit({
    actorId: user.id,
    action: "dossier.item.add",
    targetType: "DossierItem",
    targetId: item.id,
    metadata: { dossierId, kind: "external_image" },
  });
  return item;
}

export interface UpdateDossierItemInput {
  caption?: string;
  note?: string;
  excerpt?: string;
  excerptType?: TextType | null;
  excerptStart?: number | null;
  excerptEnd?: number | null;
}

export async function updateDossierItem(
  user: ActingUser,
  itemId: string,
  input: UpdateDossierItemInput
) {
  const item = await withSession(user, (tx) =>
    tx.dossierItem.findUnique({ where: { id: itemId }, select: { dossierId: true } })
  );
  if (!item) throw new Error("Dossier item not found");
  await requireEditAccess(user, item.dossierId);

  const updated = await withSession(user, (tx) =>
    tx.dossierItem.update({
      where: { id: itemId },
      data: {
        ...(input.caption !== undefined ? { caption: input.caption } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
        ...(input.excerptType !== undefined ? { excerptType: input.excerptType } : {}),
        ...(input.excerptStart !== undefined ? { excerptStart: input.excerptStart } : {}),
        ...(input.excerptEnd !== undefined ? { excerptEnd: input.excerptEnd } : {}),
      },
    })
  );
  await logAudit({
    actorId: user.id,
    action: "dossier.item.update",
    targetType: "DossierItem",
    targetId: itemId,
  });
  return updated;
}

export async function removeDossierItem(user: ActingUser, itemId: string) {
  const item = await withSession(user, (tx) =>
    tx.dossierItem.findUnique({ where: { id: itemId }, select: { dossierId: true } })
  );
  if (!item) throw new Error("Dossier item not found");
  await requireEditAccess(user, item.dossierId);

  await withSession(user, (tx) => tx.dossierItem.delete({ where: { id: itemId } }));
  await logAudit({
    actorId: user.id,
    action: "dossier.item.remove",
    targetType: "DossierItem",
    targetId: itemId,
  });
}

export async function reorderDossierItems(
  user: ActingUser,
  dossierId: string,
  orderedIds: string[]
) {
  await requireEditAccess(user, dossierId);

  await withSession(user, async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx.dossierItem.update({
        where: { id: orderedIds[i] },
        data: { sortOrder: i },
      });
    }
  });
}

// ============================================================
// Place candidates
// ============================================================

export interface PlaceCandidateInput {
  placeId?: string | null;
  name?: string;
  latitude?: number | null;
  longitude?: number | null;
  address?: string | null;
  googleMapsUrl?: string | null;
  note?: string;
  confidence?: number;
}

export async function addPlaceCandidate(
  user: ActingUser,
  dossierId: string,
  input: PlaceCandidateInput
) {
  await requireEditAccess(user, dossierId);

  const candidate = await withSession(user, async (tx) => {
    const last = await tx.dossierPlaceCandidate.findFirst({
      where: { dossierId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    return tx.dossierPlaceCandidate.create({
      data: {
        dossierId,
        placeId: input.placeId ?? null,
        name: input.name ?? "",
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        address: input.address ?? null,
        googleMapsUrl: input.googleMapsUrl ?? null,
        note: input.note ?? "",
        confidence: input.confidence ?? 0,
        sortOrder: (last?.sortOrder ?? -1) + 1,
      },
    });
  });
  await logAudit({
    actorId: user.id,
    action: "dossier.place.add",
    targetType: "DossierPlaceCandidate",
    targetId: candidate.id,
    metadata: { dossierId },
  });
  return candidate;
}

export async function updatePlaceCandidate(
  user: ActingUser,
  candidateId: string,
  input: PlaceCandidateInput
) {
  const existing = await withSession(user, (tx) =>
    tx.dossierPlaceCandidate.findUnique({
      where: { id: candidateId },
      select: { dossierId: true },
    })
  );
  if (!existing) throw new Error("Place candidate not found");
  await requireEditAccess(user, existing.dossierId);

  return withSession(user, (tx) =>
    tx.dossierPlaceCandidate.update({
      where: { id: candidateId },
      data: {
        ...(input.placeId !== undefined ? { placeId: input.placeId } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
        ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
        ...(input.address !== undefined ? { address: input.address } : {}),
        ...(input.googleMapsUrl !== undefined ? { googleMapsUrl: input.googleMapsUrl } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      },
    })
  );
}

export async function removePlaceCandidate(user: ActingUser, candidateId: string) {
  const existing = await withSession(user, (tx) =>
    tx.dossierPlaceCandidate.findUnique({
      where: { id: candidateId },
      select: { dossierId: true },
    })
  );
  if (!existing) throw new Error("Place candidate not found");
  await requireEditAccess(user, existing.dossierId);

  await withSession(user, (tx) =>
    tx.dossierPlaceCandidate.delete({ where: { id: candidateId } })
  );
}

/**
 * Promote a candidate to a confirmed Place entity.
 *
 *  - If `placeId` is set, the existing Place is bumped to status=confirmed
 *  - Otherwise, a new Entity(type=place) + Place is created from the
 *    candidate's inline fields. The new Place is linked back.
 */
export async function promotePlaceCandidate(user: ActingUser, candidateId: string) {
  const candidate = await withSession(user, (tx) =>
    tx.dossierPlaceCandidate.findUnique({
      where: { id: candidateId },
      include: { place: { include: { entity: true } } },
    })
  );
  if (!candidate) throw new Error("Place candidate not found");
  await requireEditAccess(user, candidate.dossierId);

  // Path 1: existing Place — just confirm its status.
  if (candidate.placeId) {
    await withSession(user, (tx) =>
      tx.place.update({
        where: { id: candidate.placeId! },
        data: { status: "confirmed" },
      })
    );
    await logAudit({
      actorId: user.id,
      action: "place.confirm",
      targetType: "Place",
      targetId: candidate.placeId,
      metadata: { fromCandidate: candidateId },
    });
    return { placeId: candidate.placeId };
  }

  // Path 2: inline candidate without a Place row. We need coordinates.
  if (candidate.latitude == null || candidate.longitude == null) {
    throw new Error("Confirming a candidate requires latitude/longitude");
  }
  const name = (candidate.name || "").trim() || `Unnamed (${candidate.dossierId.slice(0, 6)})`;

  const place = await withSession(user, async (tx) => {
    const entity = await tx.entity.upsert({
      where: { type_canonicalName: { type: "place", canonicalName: name } },
      update: {},
      create: {
        type: "place",
        canonicalName: name,
        normalizedName: name.toLowerCase(),
        aliases: JSON.stringify([]),
      },
    });
    // The entity may already have a Place attached (1:1 unique on entityId)
    const existing = await tx.place.findUnique({ where: { entityId: entity.id } });
    if (existing) {
      const updated = await tx.place.update({
        where: { id: existing.id },
        data: { status: "confirmed" },
      });
      await tx.dossierPlaceCandidate.update({
        where: { id: candidateId },
        data: { placeId: updated.id },
      });
      return updated;
    }
    const created = await tx.place.create({
      data: {
        entityId: entity.id,
        latitude: candidate.latitude!,
        longitude: candidate.longitude!,
        address: candidate.address ?? null,
        googleMapsUrl: candidate.googleMapsUrl ?? null,
        status: "confirmed",
      },
    });
    await tx.dossierPlaceCandidate.update({
      where: { id: candidateId },
      data: { placeId: created.id },
    });
    return created;
  });

  await logAudit({
    actorId: user.id,
    action: "place.create",
    targetType: "Place",
    targetId: place.id,
    metadata: { fromCandidate: candidateId, name },
  });

  return { placeId: place.id };
}
