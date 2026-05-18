"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ClearanceLevel, DossierAccessMode, TextType } from "@prisma/client";
import { auth } from "@/lib/auth";
import {
  createDossier as createDossierDomain,
  updateDossier as updateDossierDomain,
  deleteDossier as deleteDossierDomain,
  addAssetItem as addAssetItemDomain,
  addExternalLinkItem as addExternalLinkItemDomain,
  updateDossierItem as updateDossierItemDomain,
  removeDossierItem as removeDossierItemDomain,
  reorderDossierItems as reorderDossierItemsDomain,
  addPlaceCandidate as addPlaceCandidateDomain,
  updatePlaceCandidate as updatePlaceCandidateDomain,
  removePlaceCandidate as removePlaceCandidateDomain,
  promotePlaceCandidate as promotePlaceCandidateDomain,
} from "@/lib/domain/dossiers";
import { invalidateDossiers, invalidatePlaces } from "@/lib/cache";

async function requireUser() {
  const session = await auth();
  if (!session?.user) throw new Error("Authentication required");
  return session.user;
}

function readAccessMode(formData: FormData, field: string): DossierAccessMode | undefined {
  const v = formData.get(field);
  if (v === "private" || v === "clearance") return v;
  return undefined;
}

function readClearance(formData: FormData, field: string): ClearanceLevel | undefined {
  const v = formData.get(field);
  if (v === "public" || v === "internal" || v === "confidential" || v === "restricted") return v;
  return undefined;
}

export async function createDossierAction(formData: FormData) {
  const user = await requireUser();
  const dossier = await createDossierDomain(user, {
    title: (formData.get("title") as string) || "",
    summary: (formData.get("summary") as string) || "",
    classification: readClearance(formData, "classification"),
    viewMode: readAccessMode(formData, "viewMode"),
    editMode: readAccessMode(formData, "editMode"),
  });
  invalidateDossiers();
  revalidatePath("/dossiers");
  redirect(`/dossiers/${dossier.id}`);
}

export async function updateDossierMetaAction(id: string, formData: FormData) {
  const user = await requireUser();
  await updateDossierDomain(user, id, {
    title: formData.get("title") !== null ? (formData.get("title") as string) : undefined,
    summary: formData.get("summary") !== null ? (formData.get("summary") as string) : undefined,
    classification: readClearance(formData, "classification"),
    viewMode: readAccessMode(formData, "viewMode"),
    editMode: readAccessMode(formData, "editMode"),
  });
  invalidateDossiers();
  revalidatePath(`/dossiers/${id}`);
}

export async function deleteDossierAction(id: string) {
  const user = await requireUser();
  await deleteDossierDomain(user, id);
  invalidateDossiers();
  revalidatePath("/dossiers");
  redirect("/dossiers");
}

export async function addAssetToDossierAction(
  dossierId: string,
  assetId: string,
  options?: { caption?: string; excerpt?: string; excerptType?: TextType; excerptStart?: number; excerptEnd?: number }
) {
  const user = await requireUser();
  await addAssetItemDomain(user, dossierId, {
    assetId,
    caption: options?.caption,
    excerpt: options?.excerpt,
    excerptType: options?.excerptType,
    excerptStart: options?.excerptStart,
    excerptEnd: options?.excerptEnd,
  });
  invalidateDossiers();
  revalidatePath(`/dossiers/${dossierId}`);
}

export async function addExternalLinkAction(dossierId: string, formData: FormData) {
  const user = await requireUser();
  await addExternalLinkItemDomain(user, dossierId, {
    url: (formData.get("url") as string) || "",
    caption: (formData.get("caption") as string) || "",
    note: (formData.get("note") as string) || "",
  });
  invalidateDossiers();
  revalidatePath(`/dossiers/${dossierId}`);
}

export async function updateItemAction(itemId: string, formData: FormData) {
  const user = await requireUser();
  await updateDossierItemDomain(user, itemId, {
    caption: formData.get("caption") !== null ? (formData.get("caption") as string) : undefined,
    note: formData.get("note") !== null ? (formData.get("note") as string) : undefined,
    excerpt: formData.get("excerpt") !== null ? (formData.get("excerpt") as string) : undefined,
  });
  const dossierId = formData.get("dossierId") as string | null;
  if (dossierId) revalidatePath(`/dossiers/${dossierId}`);
}

export async function removeItemAction(itemId: string, dossierId: string) {
  const user = await requireUser();
  await removeDossierItemDomain(user, itemId);
  invalidateDossiers();
  revalidatePath(`/dossiers/${dossierId}`);
}

export async function reorderItemsAction(dossierId: string, orderedIds: string[]) {
  const user = await requireUser();
  await reorderDossierItemsDomain(user, dossierId, orderedIds);
  invalidateDossiers();
  revalidatePath(`/dossiers/${dossierId}`);
}

export async function addPlaceCandidateAction(dossierId: string, formData: FormData) {
  const user = await requireUser();
  await addPlaceCandidateDomain(user, dossierId, {
    placeId: (formData.get("placeId") as string) || null,
    name: (formData.get("name") as string) || "",
    latitude: formData.get("latitude") ? Number(formData.get("latitude")) : null,
    longitude: formData.get("longitude") ? Number(formData.get("longitude")) : null,
    address: (formData.get("address") as string) || null,
    googleMapsUrl: (formData.get("googleMapsUrl") as string) || null,
    note: (formData.get("note") as string) || "",
    confidence: formData.get("confidence") ? Number(formData.get("confidence")) : 0,
  });
  revalidatePath(`/dossiers/${dossierId}`);
}

export async function updatePlaceCandidateAction(candidateId: string, formData: FormData) {
  const user = await requireUser();
  await updatePlaceCandidateDomain(user, candidateId, {
    name: formData.get("name") !== null ? (formData.get("name") as string) : undefined,
    address: formData.get("address") !== null ? (formData.get("address") as string) : undefined,
    note: formData.get("note") !== null ? (formData.get("note") as string) : undefined,
    confidence: formData.get("confidence") !== null ? Number(formData.get("confidence")) : undefined,
  });
  const dossierId = formData.get("dossierId") as string | null;
  if (dossierId) revalidatePath(`/dossiers/${dossierId}`);
}

export async function removePlaceCandidateAction(candidateId: string, dossierId: string) {
  const user = await requireUser();
  await removePlaceCandidateDomain(user, candidateId);
  revalidatePath(`/dossiers/${dossierId}`);
}

export async function promotePlaceCandidateAction(candidateId: string, dossierId: string) {
  const user = await requireUser();
  const result = await promotePlaceCandidateDomain(user, candidateId);
  invalidatePlaces();
  revalidatePath(`/dossiers/${dossierId}`);
  revalidatePath("/places");
  return result;
}
