import type { ClearanceLevel, DossierAccessMode } from "@prisma/client";

const CLEARANCE_RANK: Record<ClearanceLevel, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

interface ActingUser {
  id: string;
  role: string;
  clearance: ClearanceLevel | string;
}

interface DossierAccessFields {
  ownerId: string;
  classification: ClearanceLevel;
  viewMode: DossierAccessMode;
  editMode: DossierAccessMode;
}

function clearanceMeetsClassification(
  user: ActingUser,
  classification: ClearanceLevel
): boolean {
  const userRank = CLEARANCE_RANK[user.clearance as ClearanceLevel];
  const classificationRank = CLEARANCE_RANK[classification];
  if (userRank === undefined || classificationRank === undefined) return false;
  return userRank >= classificationRank;
}

export function canViewDossier(user: ActingUser, dossier: DossierAccessFields): boolean {
  if (user.id === dossier.ownerId) return true;
  if (dossier.viewMode === "clearance") {
    return clearanceMeetsClassification(user, dossier.classification);
  }
  return false;
}

export function canEditDossier(user: ActingUser, dossier: DossierAccessFields): boolean {
  if (user.id === dossier.ownerId) return true;
  if (dossier.editMode === "clearance") {
    if (user.role !== "admin" && user.role !== "member") return false;
    return clearanceMeetsClassification(user, dossier.classification);
  }
  return false;
}

/**
 * Owner-only operations such as deletion and ACL changes.
 */
export function canManageDossier(user: ActingUser, dossier: DossierAccessFields): boolean {
  return user.id === dossier.ownerId;
}
