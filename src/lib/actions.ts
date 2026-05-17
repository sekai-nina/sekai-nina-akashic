"use server";

import { auth } from "@/lib/auth";
import { prisma, withClearance } from "@/lib/db";
import { normalizeText } from "@/lib/utils";
import { logAudit } from "@/lib/domain/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { revalidatePath } from "next/cache";
import { invalidateAssets, invalidateEntities, invalidateCollections, invalidatePlaces } from "@/lib/cache";
import { redirect, RedirectType } from "next/navigation";
import type { AssetKind, AssetStatus, TrustLevel, SourceType, StorageProvider, EntityType, TextType, SourceKind, AnnotationKind, RelationType, ClearanceLevel } from "@prisma/client";
import { createInvitation, deleteInvitation as deleteInvitationDomain } from "@/lib/domain/invitations";
import { backupAssetToDrive } from "@/lib/drive";
import { createAssetRelation, deleteAssetRelation } from "@/lib/domain/relations";
import { assertClearance } from "@/lib/classification";

/** Verify the calling user has clearance to access the given asset. */
async function requireClearanceForAsset(assetId: string, user: { clearance: string }) {
  const asset = await withClearance(user.clearance, (tx) =>
    tx.asset.findUnique({
      where: { id: assetId },
      select: { classification: true },
    })
  );
  if (!asset) throw new Error("Asset not found");
  assertClearance(user.clearance, asset.classification);
}

async function requireUser() {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");
  return session.user;
}

async function requireRole(roles: string[]) {
  const user = await requireUser();
  if (!roles.includes(user.role)) throw new Error("Forbidden");
  return user;
}

// ========== Assets ==========

export async function createAsset(formData: FormData) {
  const user = await requireRole(["admin", "member"]);

  const classification = (formData.get("classification") as ClearanceLevel) || user.clearance as ClearanceLevel;
  assertClearance(user.clearance, classification);

  const asset = await withClearance(user.clearance, (tx) =>
    tx.asset.create({
      data: {
        kind: (formData.get("kind") as AssetKind) || "other",
        classification,
        title: (formData.get("title") as string) || "",
        description: (formData.get("description") as string) || "",
        status: "inbox",
        trustLevel: (formData.get("trustLevel") as TrustLevel) || "unverified",
        canonicalDate: formData.get("canonicalDate")
          ? new Date(formData.get("canonicalDate") as string)
          : null,
        storageUrl: (formData.get("storageUrl") as string) || null,
        storageProvider: (formData.get("storageProvider") as StorageProvider) || "local_none",
        originalFilename: (formData.get("originalFilename") as string) || null,
        mimeType: (formData.get("mimeType") as string) || null,
        fileSize: formData.get("fileSize") ? parseInt(formData.get("fileSize") as string) : null,
        sourceType: (formData.get("sourceType") as SourceType) || "manual",
        createdById: user.id,
        updatedById: user.id,
      },
    })
  );

  await logAudit({ actorId: user.id, action: "asset.create", targetType: "Asset", targetId: asset.id });
  invalidateAssets();
  revalidatePath("/inbox");
  revalidatePath("/assets");
  redirect(`/assets/${asset.id}`);
}

export async function quickCreateAsset(formData: FormData) {
  const user = await requireRole(["admin", "member"]);

  const classification = (formData.get("classification") as ClearanceLevel) || user.clearance as ClearanceLevel;
  assertClearance(user.clearance, classification);

  const asset = await withClearance(user.clearance, (tx) =>
    tx.asset.create({
      data: {
        kind: (formData.get("kind") as AssetKind) || "other",
        classification,
        title: (formData.get("title") as string) || "",
        storageUrl: (formData.get("storageUrl") as string) || null,
        storageProvider: formData.get("storageUrl") ? "external_url" as StorageProvider : "local_none",
        status: "inbox",
        sourceType: "manual",
        createdById: user.id,
        updatedById: user.id,
      },
    })
  );

  await logAudit({ actorId: user.id, action: "asset.create", targetType: "Asset", targetId: asset.id });
  invalidateAssets();
  revalidatePath("/inbox");
  revalidatePath("/assets");
  redirect(`/assets/${asset.id}`);
}

export async function updateAsset(id: string, formData: FormData) {
  const user = await requireRole(["admin", "member"]);

  const classificationVal = formData.get("classification") as ClearanceLevel | null;
  if (classificationVal) assertClearance(user.clearance, classificationVal);

  await withClearance(user.clearance, (tx) =>
    tx.asset.update({
      where: { id },
      data: {
        kind: (formData.get("kind") as AssetKind) || undefined,
        ...(classificationVal ? { classification: classificationVal } : {}),
        title: formData.get("title") as string,
        description: formData.get("description") as string,
        status: (formData.get("status") as AssetStatus) || undefined,
        trustLevel: (formData.get("trustLevel") as TrustLevel) || undefined,
        canonicalDate: formData.get("canonicalDate")
          ? new Date(formData.get("canonicalDate") as string)
          : null,
        storageUrl: (formData.get("storageUrl") as string) || null,
        storageProvider: (formData.get("storageProvider") as StorageProvider) || undefined,
        originalFilename: (formData.get("originalFilename") as string) || null,
        mimeType: (formData.get("mimeType") as string) || null,
        sourceType: (formData.get("sourceType") as SourceType) || undefined,
        updatedById: user.id,
      },
    })
  );

  await logAudit({ actorId: user.id, action: "asset.update", targetType: "Asset", targetId: id });
  invalidateAssets();
  revalidatePath(`/assets/${id}`);
  revalidatePath("/assets");
  revalidatePath("/inbox");
  redirect(`/assets/${id}`, RedirectType.replace);
}

export async function deleteAsset(id: string) {
  const user = await requireRole(["admin", "member"]);
  await requireClearanceForAsset(id, user);
  const asset = await withClearance(user.clearance, async (tx) => {
    const found = await tx.asset.findUnique({ where: { id } });
    if (!found) throw new Error("Asset not found");
    await tx.asset.delete({ where: { id } });
    return found;
  });
  await logAudit({ actorId: user.id, action: "asset.delete", targetType: "Asset", targetId: id, metadata: { title: asset.title } });
  invalidateAssets();
  revalidatePath("/assets");
  revalidatePath("/inbox");
  revalidatePath("/search");
  redirect("/assets");
}

export async function updateAssetStatus(id: string, status: AssetStatus) {
  const user = await requireRole(["admin", "member"]);
  await requireClearanceForAsset(id, user);
  await withClearance(user.clearance, (tx) =>
    tx.asset.update({ where: { id }, data: { status, updatedById: user.id } })
  );
  await logAudit({ actorId: user.id, action: "asset.update_status", targetType: "Asset", targetId: id, metadata: { status } });
  invalidateAssets();
  revalidatePath(`/assets/${id}`);
  revalidatePath("/assets");
  revalidatePath("/inbox");
}

// ========== Asset Relations ==========

export async function addAssetRelation(sourceId: string, formData: FormData) {
  const user = await requireRole(["admin", "member"]);
  await requireClearanceForAsset(sourceId, user);
  const targetId = (formData.get("targetId") as string)?.trim();
  const relationType = formData.get("relationType") as RelationType;

  if (!targetId || !relationType) return;

  await createAssetRelation(
    { sourceId, targetId, relationType },
    user.id,
    user.clearance,
  );

  invalidateAssets();
  revalidatePath(`/assets/${sourceId}`);
  revalidatePath(`/assets/${targetId}`);
}

export async function removeAssetRelation(relationId: string, assetId: string) {
  const user = await requireRole(["admin", "member"]);
  await requireClearanceForAsset(assetId, user);
  const relation = await deleteAssetRelation(relationId, user.id, user.clearance);

  invalidateAssets();
  revalidatePath(`/assets/${relation.sourceId}`);
  revalidatePath(`/assets/${relation.targetId}`);
  revalidatePath(`/assets/${assetId}`);
}

// ========== Entities ==========

export async function addEntityToAsset(assetId: string, formData: FormData) {
  const user = await requireRole(["admin", "member"]);
  await requireClearanceForAsset(assetId, user);
  const entityType = formData.get("entityType") as EntityType;
  const canonicalName = (formData.get("canonicalName") as string).trim();
  const roleLabel = (formData.get("roleLabel") as string) || null;

  if (!canonicalName) return;

  const entity = await prisma.entity.upsert({
    where: { type_canonicalName: { type: entityType, canonicalName } },
    create: {
      type: entityType,
      canonicalName,
      normalizedName: normalizeText(canonicalName),
    },
    update: {},
  });

  await withClearance(user.clearance, (tx) =>
    tx.assetEntity.upsert({
      where: { assetId_entityId: { assetId, entityId: entity.id } },
      create: { assetId, entityId: entity.id, roleLabel },
      update: { roleLabel },
    })
  );

  await logAudit({ actorId: user.id, action: "entity.add_to_asset", targetType: "AssetEntity", targetId: `${assetId}:${entity.id}` });
  backupAssetToDrive(assetId).catch(() => {});
  revalidatePath(`/assets/${assetId}`);
}

export async function removeEntityFromAsset(assetId: string, entityId: string) {
  const user = await requireRole(["admin", "member"]);
  await requireClearanceForAsset(assetId, user);
  await withClearance(user.clearance, (tx) =>
    tx.assetEntity.deleteMany({ where: { assetId, entityId } })
  );
  backupAssetToDrive(assetId).catch(() => {});
  revalidatePath(`/assets/${assetId}`);
}

export async function searchEntities(query: string, type?: EntityType) {
  if (!query.trim()) return [];
  const where: Record<string, unknown> = {
    OR: [
      { canonicalName: { contains: query, mode: "insensitive" } },
      { normalizedName: { contains: normalizeText(query), mode: "insensitive" } },
    ],
  };
  if (type) where.type = type;
  return prisma.entity.findMany({ where: where as never, take: 20, orderBy: { canonicalName: "asc" } });
}

// ========== AssetText ==========

export async function addAssetText(assetId: string, formData: FormData) {
  const user = await requireRole(["admin", "member"]);
  await requireClearanceForAsset(assetId, user);
  const content = (formData.get("content") as string) || "";
  const textType = (formData.get("textType") as TextType) || "note";

  await withClearance(user.clearance, (tx) =>
    tx.assetText.create({
      data: {
        assetId,
        textType,
        content,
        normalizedContent: normalizeText(content),
        createdById: user.id,
      },
    })
  );
  backupAssetToDrive(assetId).catch((err) =>
    console.error("Asset backup to Drive failed:", err)
  );
  revalidatePath(`/assets/${assetId}`);
}

export async function updateAssetText(id: string, formData: FormData) {
  const user = await requireRole(["admin", "member"]);
  const text = await withClearance(user.clearance, (tx) =>
    tx.assetText.findUnique({ where: { id } })
  );
  if (text) await requireClearanceForAsset(text.assetId, user);
  const content = (formData.get("content") as string) || "";
  await withClearance(user.clearance, (tx) =>
    tx.assetText.update({
      where: { id },
      data: { content, normalizedContent: normalizeText(content) },
    })
  );
  if (text) {
    backupAssetToDrive(text.assetId).catch(() => {});
    revalidatePath(`/assets/${text.assetId}`);
  }
}

export async function deleteAssetText(id: string) {
  const user = await requireRole(["admin", "member"]);
  const text = await withClearance(user.clearance, (tx) =>
    tx.assetText.findUnique({ where: { id } })
  );
  if (text) await requireClearanceForAsset(text.assetId, user);
  await withClearance(user.clearance, (tx) =>
    tx.assetText.delete({ where: { id } })
  );
  if (text) {
    backupAssetToDrive(text.assetId).catch(() => {});
    revalidatePath(`/assets/${text.assetId}`);
  }
}

// ========== SourceRecord ==========

export async function addSourceRecord(assetId: string, formData: FormData) {
  const user = await requireRole(["admin", "member"]);
  await requireClearanceForAsset(assetId, user);
  await withClearance(user.clearance, (tx) =>
    tx.sourceRecord.create({
      data: {
        assetId,
        sourceKind: (formData.get("sourceKind") as SourceKind) || "other",
        title: (formData.get("sourceTitle") as string) || "",
        url: (formData.get("sourceUrl") as string) || null,
        publisher: (formData.get("publisher") as string) || null,
        publishedAt: formData.get("publishedAt")
          ? new Date(formData.get("publishedAt") as string)
          : null,
      },
    })
  );
  backupAssetToDrive(assetId).catch(() => {});
  revalidatePath(`/assets/${assetId}`);
}

export async function deleteSourceRecord(id: string) {
  const user = await requireRole(["admin", "member"]);
  const src = await withClearance(user.clearance, (tx) =>
    tx.sourceRecord.findUnique({ where: { id } })
  );
  if (src) await requireClearanceForAsset(src.assetId, user);
  await withClearance(user.clearance, (tx) =>
    tx.sourceRecord.delete({ where: { id } })
  );
  if (src) {
    backupAssetToDrive(src.assetId).catch(() => {});
    revalidatePath(`/assets/${src.assetId}`);
  }
}

// ========== Annotation ==========

export async function addAnnotation(assetId: string, formData: FormData) {
  const user = await requireRole(["admin", "member"]);
  await requireClearanceForAsset(assetId, user);
  await withClearance(user.clearance, (tx) =>
    tx.annotation.create({
      data: {
        assetId,
        kind: (formData.get("annotationKind") as AnnotationKind) || "note",
        body: (formData.get("body") as string) || "",
        createdById: user.id,
      },
    })
  );
  backupAssetToDrive(assetId).catch(() => {});
  revalidatePath(`/assets/${assetId}`);
}

export async function deleteAnnotation(id: string) {
  const user = await requireRole(["admin", "member"]);
  const ann = await withClearance(user.clearance, (tx) =>
    tx.annotation.findUnique({ where: { id } })
  );
  if (ann) await requireClearanceForAsset(ann.assetId, user);
  await withClearance(user.clearance, (tx) =>
    tx.annotation.delete({ where: { id } })
  );
  if (ann) {
    backupAssetToDrive(ann.assetId).catch(() => {});
    revalidatePath(`/assets/${ann.assetId}`);
  }
}

// ========== Collections ==========

export async function createCollection(formData: FormData) {
  const user = await requireRole(["admin", "member"]);
  const collection = await prisma.collection.create({
    data: {
      name: (formData.get("name") as string) || "",
      description: (formData.get("description") as string) || "",
      ownerId: user.id,
    },
  });
  await logAudit({ actorId: user.id, action: "collection.create", targetType: "Collection", targetId: collection.id });
  invalidateCollections();
  revalidatePath("/collections");
  redirect(`/collections/${collection.id}`);
}

export async function addToCollection(collectionId: string, assetId: string) {
  const user = await requireRole(["admin", "member"]);
  await withClearance(user.clearance, (tx) =>
    tx.collectionItem.upsert({
      where: { collectionId_assetId: { collectionId, assetId } },
      create: { collectionId, assetId },
      update: {},
    })
  );
  revalidatePath(`/collections/${collectionId}`);
}

export async function removeFromCollection(collectionId: string, assetId: string) {
  const user = await requireRole(["admin", "member"]);
  await withClearance(user.clearance, (tx) =>
    tx.collectionItem.deleteMany({ where: { collectionId, assetId } })
  );
  revalidatePath(`/collections/${collectionId}`);
}

export async function updateCollectionItem(id: string, formData: FormData) {
  const user = await requireRole(["admin", "member"]);
  await withClearance(user.clearance, (tx) =>
    tx.collectionItem.update({
      where: { id },
      data: {
        note: (formData.get("note") as string) || "",
        sortOrder: formData.get("sortOrder") ? parseInt(formData.get("sortOrder") as string) : undefined,
      },
    })
  );
}

export async function deleteCollection(id: string) {
  await requireRole(["admin", "member"]);
  await prisma.collection.delete({ where: { id } });
  invalidateCollections();
  revalidatePath("/collections");
  redirect("/collections");
}

// ========== Users (admin) ==========

export async function createUser(formData: FormData) {
  const admin = await requireRole(["admin"]);
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  const name = formData.get("name") as string;
  const role = (formData.get("role") as "admin" | "member" | "viewer") || "member";
  const clearance = (formData.get("clearance") as ClearanceLevel) || "internal";

  // Admin cannot grant clearance above their own
  assertClearance(admin.clearance, clearance);

  // Create user in Supabase Auth
  const supabase = createAdminClient();
  const { error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`Supabase Auth: ${error.message}`);

  // Create user in our User table
  await prisma.user.create({
    data: { email, name, passwordHash: "", role, clearance },
  });
  revalidatePath("/admin/users");
}

export async function updateUser(id: string, formData: FormData) {
  const admin = await requireRole(["admin"]);
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new Error("User not found");

  const newEmail = formData.get("email") as string;
  const name = formData.get("name") as string;
  const role = formData.get("role") as string;
  const password = formData.get("password") as string;
  const clearanceVal = formData.get("clearance") as ClearanceLevel | null;
  // Admin cannot grant clearance above their own
  if (clearanceVal) assertClearance(admin.clearance, clearanceVal);

  // Update Supabase Auth user if email or password changed
  const supabase = createAdminClient();
  const { data: authUsers } = await supabase.auth.admin.listUsers();
  const authUser = authUsers?.users.find((u) => u.email === user.email);
  if (authUser) {
    const updates: Record<string, string> = {};
    if (newEmail !== user.email) updates.email = newEmail;
    if (password) updates.password = password;
    if (Object.keys(updates).length > 0) {
      await supabase.auth.admin.updateUserById(authUser.id, updates);
    }
  }

  const clearance = (formData.get("clearance") as ClearanceLevel) || undefined;

  await prisma.user.update({
    where: { id },
    data: {
      email: newEmail,
      name,
      role: role as "admin" | "member" | "viewer",
      ...(clearance ? { clearance } : {}),
    },
  });
  revalidatePath("/admin/users");
}

export async function deleteUser(id: string) {
  await requireRole(["admin"]);
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new Error("User not found");

  // Delete from Supabase Auth
  const supabase = createAdminClient();
  const { data: authUsers } = await supabase.auth.admin.listUsers();
  const authUser = authUsers?.users.find((u) => u.email === user.email);
  if (authUser) {
    await supabase.auth.admin.deleteUser(authUser.id);
  }

  await prisma.user.delete({ where: { id } });
  revalidatePath("/admin/users");
}

// ========== Entity Aliases ==========

export async function updateEntityAliases(entityId: string, formData: FormData) {
  await requireRole(["admin", "member"]);
  const aliasesRaw = formData.get("aliases") as string;
  const aliases = aliasesRaw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  await prisma.entity.update({
    where: { id: entityId },
    data: { aliases },
  });

  invalidateEntities();
  revalidatePath(`/entities/${entityId}`);
}

export async function addEntityAlias(entityId: string, formData: FormData) {
  await requireRole(["admin", "member"]);
  const alias = (formData.get("alias") as string).trim();
  if (!alias) return;

  const entity = await prisma.entity.findUnique({ where: { id: entityId } });
  if (!entity) throw new Error("Entity not found");

  const current = (entity.aliases as string[]) || [];
  if (current.includes(alias)) return;

  await prisma.entity.update({
    where: { id: entityId },
    data: { aliases: [...current, alias] },
  });

  invalidateEntities();
  revalidatePath(`/entities/${entityId}`);
}

export async function removeEntityAlias(entityId: string, alias: string) {
  await requireRole(["admin", "member"]);

  const entity = await prisma.entity.findUnique({ where: { id: entityId } });
  if (!entity) throw new Error("Entity not found");

  const current = (entity.aliases as string[]) || [];
  await prisma.entity.update({
    where: { id: entityId },
    data: { aliases: current.filter((a) => a !== alias) },
  });

  invalidateEntities();
  revalidatePath(`/entities/${entityId}`);
}

// ========== Testimonials ==========

export async function reviewTestimonial(id: string, status: "approved" | "rejected") {
  const user = await requireRole(["admin", "member"]);

  await withClearance(user.clearance, (tx) =>
    tx.testimonial.update({
      where: { id },
      data: { status, reviewedAt: new Date() },
    })
  );

  revalidatePath("/testimonials");
}

export async function updateTestimonialCategory(id: string, category: string) {
  const user = await requireRole(["admin", "member"]);

  await withClearance(user.clearance, (tx) =>
    tx.testimonial.update({
      where: { id },
      data: { category: category as "personality" },
    })
  );

  revalidatePath("/testimonials");
}

// ========== Invitations ==========

export async function createInvitationAction(formData: FormData) {
  const user = await requireRole(["admin"]);
  const email = (formData.get("email") as string)?.trim() || undefined;
  const role = (formData.get("role") as "admin" | "member" | "viewer") || "member";
  const clearance = (formData.get("clearance") as ClearanceLevel) || "internal";
  const expiresInDays = parseInt(formData.get("expiresInDays") as string) || 7;

  // Admin cannot grant clearance above their own
  assertClearance(user.clearance, clearance);

  await createInvitation(user.id, { email, role, clearance, expiresInDays });
  revalidatePath("/admin/invitations");
}

export async function deleteInvitationAction(id: string) {
  await requireRole(["admin"]);
  await deleteInvitationDomain(id);
  revalidatePath("/admin/invitations");
}

// ========== Places ==========

export async function createPlaceAction(formData: FormData) {
  const user = await requireRole(["admin", "member"]);

  const { createPlace } = await import("@/lib/domain/places");
  const place = await createPlace(
    {
      canonicalName: (formData.get("name") as string) || "",
      latitude: parseFloat(formData.get("latitude") as string),
      longitude: parseFloat(formData.get("longitude") as string),
      googleMapsUrl: (formData.get("googleMapsUrl") as string) || undefined,
      address: (formData.get("address") as string) || undefined,
      description: (formData.get("description") as string) || undefined,
      classification: (formData.get("classification") as ClearanceLevel) || undefined,
    },
    user.clearance
  );

  invalidatePlaces();
  revalidatePath("/places");
  redirect(`/places/${place.id}`);
}

export async function updatePlaceAction(id: string, formData: FormData) {
  const user = await requireRole(["admin", "member"]);

  const { updatePlace } = await import("@/lib/domain/places");
  await updatePlace(
    id,
    {
      canonicalName: (formData.get("name") as string) || undefined,
      latitude: formData.get("latitude") ? parseFloat(formData.get("latitude") as string) : undefined,
      longitude: formData.get("longitude") ? parseFloat(formData.get("longitude") as string) : undefined,
      googleMapsUrl: formData.has("googleMapsUrl") ? (formData.get("googleMapsUrl") as string) || undefined : undefined,
      address: formData.has("address") ? (formData.get("address") as string) || undefined : undefined,
      description: formData.has("description") ? (formData.get("description") as string) || undefined : undefined,
      classification: (formData.get("classification") as ClearanceLevel) || undefined,
    },
    user.clearance
  );

  invalidatePlaces();
  revalidatePath("/places");
  revalidatePath(`/places/${id}`);
}

export async function deletePlaceAction(id: string) {
  const user = await requireRole(["admin", "member"]);

  const { deletePlace } = await import("@/lib/domain/places");
  await deletePlace(id, user.clearance);

  invalidatePlaces();
  revalidatePath("/places");
  redirect("/places");
}
