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
  removeAssetFromDossier as removeAssetFromDossierDomain,
  listDossiersContainingAsset,
  reorderDossierItems as reorderDossierItemsDomain,
  addPlaceCandidate as addPlaceCandidateDomain,
  updatePlaceCandidate as updatePlaceCandidateDomain,
  removePlaceCandidate as removePlaceCandidateDomain,
  promotePlaceCandidate as promotePlaceCandidateDomain,
} from "@/lib/domain/dossiers";
import { invalidateDossiers, invalidateEntities, invalidatePlaces } from "@/lib/cache";
import { assertClearance } from "@/lib/classification";
import { updatePlace } from "@/lib/domain/places";

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

/**
 * ドシエを削除する。
 *
 * **失敗の理由を返す。** 投げっぱなしだと本番ではメッセージが伏せられ、画面には
 * 「エラーが発生しました」しか出ない。ミーグリで使われているドシエは消せない (#112) ので、
 * 何をすればよいか伝わる必要がある
 */
export async function deleteDossierAction(id: string) {
  const user = await requireUser();
  try {
    await deleteDossierDomain(user, id);
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
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
  // アセット詳細の「含まれているドシエ」を追従させる
  revalidatePath(`/assets/${assetId}`);
}

/** このアセットが入っている企画 (検索・ギャラリーのピッカーを開いたときに引く) */
export async function listAssetDossiersAction(assetId: string) {
  const user = await requireUser();
  const rows = await listDossiersContainingAsset(user, assetId);
  return rows.map((d) => ({ id: d.id, title: d.title, itemCount: d.itemCount }));
}

/** ドシエからアセットを外す (抜粋ごとの重複もまとめて)。アセット詳細のピッカー / パネルから呼ぶ */
export async function removeAssetFromDossierAction(dossierId: string, assetId: string) {
  const user = await requireUser();
  await removeAssetFromDossierDomain(user, dossierId, assetId);
  invalidateDossiers();
  revalidatePath(`/dossiers/${dossierId}`);
  revalidatePath(`/assets/${assetId}`);
}

/**
 * Create a new dossier and immediately add the given asset to it.
 * Returns the new dossier id so the caller can navigate or surface a link.
 */
export async function createDossierWithAssetAction(
  title: string,
  assetId: string,
  options?: { caption?: string; excerpt?: string; excerptType?: TextType; excerptStart?: number; excerptEnd?: number }
): Promise<{ dossierId: string; title: string }> {
  const user = await requireUser();
  const dossier = await createDossierDomain(user, { title });
  await addAssetItemDomain(user, dossier.id, {
    assetId,
    caption: options?.caption,
    excerpt: options?.excerpt,
    excerptType: options?.excerptType,
    excerptStart: options?.excerptStart,
    excerptEnd: options?.excerptEnd,
  });
  invalidateDossiers();
  revalidatePath("/dossiers");
  revalidatePath(`/dossiers/${dossier.id}`);
  revalidatePath(`/assets/${assetId}`);
  return { dossierId: dossier.id, title: dossier.title };
}

export async function addExternalLinkAction(dossierId: string, formData: FormData) {
  const user = await requireUser();
  // One item can hold multiple links — accept a newline-separated list,
  // trim/dedupe, and store them joined by "\n".
  const raw = (formData.get("url") as string) || "";
  const urls = Array.from(
    new Set(
      raw
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
  if (urls.length === 0) return;
  await addExternalLinkItemDomain(user, dossierId, {
    url: urls.join("\n"),
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

/**
 * 確定済みの聖地の公開範囲 (サイトに出すか) を企画の画面から変える。
 * /places の編集と同じく admin / member だけ、自分のクリアランス以下だけ
 */
export async function updateCandidatePlaceClassificationAction(
  placeId: string,
  dossierId: string,
  classification: ClearanceLevel
) {
  const user = await requireUser();
  if (user.role !== "admin" && user.role !== "member") throw new Error("公開範囲を変えられるのは管理者とメンバーだけです");
  assertClearance(user.clearance, classification);
  await updatePlace(placeId, { classification }, user.clearance);
  invalidatePlaces();
  invalidateEntities();
  revalidatePath(`/dossiers/${dossierId}`);
  revalidatePath("/places");
  revalidatePath(`/places/${placeId}`);
}

export async function promotePlaceCandidateAction(
  candidateId: string,
  dossierId: string,
  classification?: ClearanceLevel
) {
  const user = await requireUser();
  const result = await promotePlaceCandidateDomain(user, candidateId, classification);
  invalidatePlaces();
  // place エンティティの見え方は Place の公開範囲で決まる (entityClearanceWhere)
  invalidateEntities();
  revalidatePath(`/dossiers/${dossierId}`);
  revalidatePath("/places");
  return result;
}
