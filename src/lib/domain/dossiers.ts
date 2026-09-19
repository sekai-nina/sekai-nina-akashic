import {
  DossierKind,
  type ClearanceLevel,
  type DossierAccessMode,
  type DossierItemKind,
  type TextType,
} from "@prisma/client";
import { withSession } from "@/lib/db";
import { canEditDossier, canManageDossier } from "@/lib/auth/dossier-permissions";
import { logAudit } from "./audit";
import { entityClearanceWhere } from "./entities";

interface ActingUser {
  id: string;
  role: string;
  clearance: string;
}

/**
 * クリップのプール (`kind = clips`) は一覧・ピッカーに出さない。
 * プールは `/clips` が専用の画面で、通常のドシエとして触らせると
 * 「ドシエに追加」でプールに入れたり、プールを削除したりできてしまう (#41)。
 */
export const NOT_CLIP_POOL = { kind: { not: DossierKind.clips } } as const;

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
      where: NOT_CLIP_POOL,
      orderBy: { updatedAt: "desc" },
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true } },
        _count: { select: { items: true, placeCandidates: true, articles: true } },
        // 記事の素材ドシエか (一覧で「記事」バッジと記事名検索に使う)。#41 のバックフィルで
        // 記事 1 本につき 1 ドシエ作るので、通常のドシエと見分けられるようにする。
        // 件数は _count で数える (take で切ると 4 本以上のとき数が合わない)
        articles: { select: { shortId: true, title: true }, take: 3 },
      },
    })
  );
}

/**
 * List dossiers the user can EDIT (owner OR editMode='clearance' & clearance meets classification).
 * Used to populate the AddToDossier picker.
 *
 * `withArticles` を付けると素材ドシエの記事タイトルも返す (`/clips` の移動先ピッカーが
 * 記事名で探せるように)。/search 等の汎用ピッカーは使わないので既定では引かない。
 */
export async function listEditableDossiers(user: ActingUser, opts?: { withArticles?: boolean }) {
  const all = await withSession(user, (tx) =>
    tx.dossier.findMany({
      where: NOT_CLIP_POOL,
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        ownerId: true,
        classification: true,
        viewMode: true,
        editMode: true,
        ...(opts?.withArticles ? { articles: { select: { shortId: true, title: true }, take: 3 } } : {}),
      },
    })
  );
  return all.filter((d) => canEditDossier(user, d));
}

/** ドシエの種別だけ引く (詳細ページがプールを /clips へ逃がすとき、アイテム全件を読む前に見る) */
export async function getDossierKind(user: ActingUser, id: string): Promise<DossierKind | null> {
  const row = await withSession(user, (tx) => tx.dossier.findUnique({ where: { id }, select: { kind: true } }));
  return row?.kind ?? null;
}

/** 記事詳細の「素材ドシエ」表示用。private なドシエは所有者にしか見えない (= null) */
export async function getDossierSummary(user: ActingUser, id: string) {
  return withSession(user, (tx) =>
    tx.dossier.findUnique({
      where: { id },
      select: { id: true, title: true, _count: { select: { items: true } } },
    })
  );
}

export async function getDossier(user: ActingUser, id: string) {
  return withSession(user, (tx) =>
    tx.dossier.findUnique({
      where: { id },
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true } },
        // このドシエを素材にした記事 (#41)。Article は非保護なので RLS で落ちない
        articles: { select: { shortId: true, title: true, path: true }, orderBy: { title: "asc" } },
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
                storageKey: true,
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
                  where: { entity: entityClearanceWhere(user.clearance) },
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
      select: { ownerId: true, classification: true, viewMode: true, editMode: true, kind: true },
    })
  );
}

/**
 * クリップのプールは書き換え・削除させない。
 * 共有設定を private にすると他の人のクリップが見えなくなり、削除すると
 * 全員のクリップが消える。所有者 (= 最初にクリップした人) にも許さない
 */
function assertNotClipPool(access: { kind: DossierKind }) {
  if (access.kind === DossierKind.clips) {
    throw new Error("クリップのプールは変更・削除できません");
  }
}

export async function updateDossier(user: ActingUser, id: string, input: UpdateDossierInput) {
  const access = await loadAccessFields(user, id);
  if (!access) throw new Error("Dossier not found");
  assertNotClipPool(access);
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
  assertNotClipPool(access);
  if (!canManageDossier(user, access)) {
    throw new Error("Only the owner can delete a dossier");
  }
  // **ミーグリの素材置き場は先に回のほうを消してもらう (#112)。** 回はスケッチ・
  // 切り抜き枠・記事の紐づけ・除外リストを持っていて、ここで巻き添えにすると戻せない
  // (DB 側も Restrict で止まるが、生の外部キー違反を画面に出さない)
  const meetGreet = await withSession(user, (tx) =>
    tx.meetGreet.findUnique({ where: { dossierId: id }, select: { date: true } })
  );
  if (meetGreet) {
    throw new Error(
      `${meetGreet.date} のミーグリで使われているドシエです。先にミーグリのほうを削除してください`
    );
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

/**
 * 編集権限の確認。
 *
 * **クリップのプールは既定で拒否する。** UI のピッカーはプールを隠しているが、Server Action の
 * `dossierId` はクライアント入力なので、ここで止めないと「ドシエに追加」でプールに任意の
 * アセットを入れられる (= `createClip` の classification 検査を素通りする)。プール内の
 * アイテム操作 (メモ編集・削除) だけ `allowClipPool` で通す
 */
export async function requireEditAccess(
  user: ActingUser,
  dossierId: string,
  opts?: { allowClipPool?: boolean }
) {
  const access = await loadAccessFields(user, dossierId);
  if (!access) throw new Error("Dossier not found");
  if (!opts?.allowClipPool && access.kind === DossierKind.clips) {
    throw new Error("クリップのプールには直接追加できません (アセット詳細の「クリップ」から)");
  }
  if (!canEditDossier(user, access)) {
    throw new Error("Insufficient permission to edit this dossier");
  }
  return access;
}

export async function nextSortOrder(
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

  // An excerpt (range selection) always creates a NEW item so a single asset
  // can contribute multiple quotes to the same dossier. A plain asset reference
  // (no excerpt) stays idempotent: reuse the existing excerpt-less reference for
  // this asset if one is already present.
  const hasExcerpt = !!input.excerpt && input.excerpt.trim() !== "";

  const item = await withSession(user, async (tx) => {
    if (!hasExcerpt) {
      const existing = await tx.dossierItem.findFirst({
        where: { dossierId, assetId: input.assetId, excerpt: "" },
        orderBy: { createdAt: "asc" },
      });
      if (existing) {
        return tx.dossierItem.update({
          where: { id: existing.id },
          data: {
            ...(input.caption !== undefined ? { caption: input.caption } : {}),
            ...(input.note !== undefined ? { note: input.note } : {}),
          },
        });
      }
    }

    const sortOrder = await nextSortOrder(tx, dossierId);
    return tx.dossierItem.create({
      data: {
        dossierId,
        kind: "asset_ref",
        assetId: input.assetId,
        caption: input.caption ?? "",
        note: input.note ?? "",
        excerpt: input.excerpt ?? "",
        excerptType: input.excerptType ?? null,
        excerptStart: input.excerptStart ?? null,
        excerptEnd: input.excerptEnd ?? null,
        createdById: user.id,
        sortOrder,
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
        createdById: user.id,
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
        createdById: user.id,
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
  // クリップ (プールのアイテム) のメモ編集もここを通る
  await requireEditAccess(user, item.dossierId, { allowClipPool: true });

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
  await requireEditAccess(user, item.dossierId, { allowClipPool: true });

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
