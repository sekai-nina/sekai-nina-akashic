import { ClearanceLevel, type PlaceKind, type Prisma } from "@prisma/client";
import { withClearance } from "@/lib/db";
import { isPublishablePlace } from "@/lib/articles/frontmatter";
import { normalizeText } from "@/lib/utils";
import { logAudit } from "./audit";

export interface CreatePlaceData {
  canonicalName: string;
  latitude: number;
  longitude: number;
  googleMapsUrl?: string;
  address?: string;
  description?: string;
  aliases?: string[];
  kind?: PlaceKind | null;
  area?: string | null;
  classification?: ClearanceLevel;
}

export interface UpdatePlaceData {
  canonicalName?: string;
  latitude?: number;
  longitude?: number;
  googleMapsUrl?: string;
  address?: string;
  description?: string;
  kind?: PlaceKind | null; // null で未設定に戻す。undefined は変更なし
  area?: string | null; // 同上
  classification?: ClearanceLevel;
}

// エリア名は前後の空白を落とし、空なら未設定 (null) にする
export function normalizeArea(area: string | null | undefined): string | null | undefined {
  if (area === undefined) return undefined;
  const t = (area ?? "").trim();
  return t ? t : null;
}

/**
 * 聖地が記事の push 出力 (`locations` の name / 有無) を変えたときに、紐づく記事を push 待ちにする (#283)。
 * `editedAt` も立てる: 立てないと push 前の再取り込みが「ファイルと値が違う」を取りこぼし扱いにして
 * dirty を落とす (取り込みの preserved ガードは editedAt を見る)
 */
async function markArticlesForPlace(tx: Prisma.TransactionClient, placeId: string) {
  await tx.article.updateMany({
    where: {
      OR: [
        { places: { some: { placeId } } },
        // backfill 前・backfill が移せなかった記事は frontmatterExtra.locations に place_id が残っている
        { frontmatterExtra: { path: ["locations"], array_contains: [{ place_id: placeId }] } },
      ],
    },
    data: { dirty: true, editedAt: new Date() },
  });
}

export type PlaceWithEntity = Awaited<ReturnType<typeof getPlaceById>> & {};

export async function createPlace(data: CreatePlaceData, clearance: string) {
  const normalizedName = normalizeText(data.canonicalName);

  const place = await withClearance(clearance, async (tx) => {
    const entity = await tx.entity.upsert({
      where: {
        type_canonicalName: { type: "place", canonicalName: data.canonicalName },
      },
      update: {
        description: data.description ?? undefined,
        aliases: data.aliases ? JSON.stringify(data.aliases) : undefined,
      },
      create: {
        type: "place",
        canonicalName: data.canonicalName,
        normalizedName,
        description: data.description ?? "",
        aliases: JSON.stringify(data.aliases ?? []),
      },
    });

    return tx.place.create({
      data: {
        entityId: entity.id,
        latitude: data.latitude,
        longitude: data.longitude,
        googleMapsUrl: data.googleMapsUrl ?? null,
        address: data.address ?? null,
        kind: data.kind ?? null,
        area: normalizeArea(data.area) ?? null,
        classification: data.classification ?? "internal",
      },
      include: {
        entity: {
          include: { _count: { select: { assets: true } } },
        },
      },
    });
  });

  await logAudit({
    action: "place.create",
    targetType: "Place",
    targetId: place.id,
    metadata: { canonicalName: data.canonicalName },
  });

  return place;
}

export async function updatePlace(id: string, data: UpdatePlaceData, clearance: string) {
  const place = await withClearance(clearance, async (tx) => {
    const existing = await tx.place.findUnique({
      where: { id },
      include: { entity: true },
    });
    if (!existing) throw new Error("Place not found");

    // 記事の locations は聖地の正式名で書き出し、公開範囲 (public / internal) の聖地だけ載せる
    const renamed = !!data.canonicalName && data.canonicalName !== existing.entity.canonicalName;
    const publishabilityChanged =
      data.classification !== undefined &&
      isPublishablePlace(existing) !== isPublishablePlace({ classification: data.classification });
    if (renamed || publishabilityChanged) await markArticlesForPlace(tx, id);

    if (data.canonicalName || data.description !== undefined) {
      await tx.entity.update({
        where: { id: existing.entityId },
        data: {
          ...(data.canonicalName
            ? {
                canonicalName: data.canonicalName,
                normalizedName: normalizeText(data.canonicalName),
              }
            : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
        },
      });
    }

    return tx.place.update({
      where: { id },
      data: {
        ...(data.latitude !== undefined ? { latitude: data.latitude } : {}),
        ...(data.longitude !== undefined ? { longitude: data.longitude } : {}),
        ...(data.googleMapsUrl !== undefined ? { googleMapsUrl: data.googleMapsUrl } : {}),
        ...(data.address !== undefined ? { address: data.address } : {}),
        ...(data.kind !== undefined ? { kind: data.kind } : {}),
        ...(data.area !== undefined ? { area: normalizeArea(data.area) } : {}),
        ...(data.classification !== undefined ? { classification: data.classification } : {}),
      },
      include: {
        entity: {
          include: { _count: { select: { assets: true } } },
        },
      },
    });
  });

  await logAudit({
    action: "place.update",
    targetType: "Place",
    targetId: place.id,
    metadata: data as unknown as Record<string, unknown>,
  });

  return place;
}

export async function deletePlace(id: string, clearance: string) {
  const place = await withClearance(clearance, async (tx) => {
    const found = await tx.place.findUnique({
      where: { id },
      include: { entity: true },
    });
    if (!found) throw new Error("Place not found");

    // ArticlePlace も消えるので、locations に載っていた記事は push で消す必要がある
    if (isPublishablePlace(found)) await markArticlesForPlace(tx, id);

    // Deleting the entity cascades to the place
    await tx.entity.delete({ where: { id: found.entityId } });
    return found;
  });

  await logAudit({
    action: "place.delete",
    targetType: "Place",
    targetId: id,
    metadata: { canonicalName: place.entity.canonicalName },
  });
}

export async function listPlaces(clearance: string) {
  const clearanceOrder: ClearanceLevel[] = ["public", "internal", "confidential", "restricted"];
  const maxLevel = clearanceOrder.indexOf(clearance as ClearanceLevel);
  const allowedLevels = clearanceOrder.slice(0, maxLevel + 1);

  return withClearance(clearance, (tx) =>
    tx.place.findMany({
      where: {
        classification: { in: allowedLevels.length > 0 ? allowedLevels : ["public"] },
      },
      include: {
        entity: {
          include: { _count: { select: { assets: true } } },
        },
      },
      orderBy: { entity: { canonicalName: "asc" } },
    })
  );
}

export async function getPlaceById(id: string, clearance: string) {
  const clearanceOrder: ClearanceLevel[] = ["public", "internal", "confidential", "restricted"];
  const maxLevel = clearanceOrder.indexOf(clearance as ClearanceLevel);
  const allowedLevels = clearanceOrder.slice(0, maxLevel + 1);

  return withClearance(clearance, (tx) =>
    tx.place.findFirst({
      where: {
        id,
        classification: { in: allowedLevels.length > 0 ? allowedLevels : ["public"] },
      },
      include: {
        entity: {
          include: { _count: { select: { assets: true } } },
        },
      },
    })
  );
}

export async function getPlaceByEntityId(entityId: string, clearance: string) {
  const clearanceOrder: ClearanceLevel[] = ["public", "internal", "confidential", "restricted"];
  const maxLevel = clearanceOrder.indexOf(clearance as ClearanceLevel);
  const allowedLevels = clearanceOrder.slice(0, maxLevel + 1);

  return withClearance(clearance, (tx) =>
    tx.place.findFirst({
      where: {
        entityId,
        classification: { in: allowedLevels.length > 0 ? allowedLevels : ["public"] },
      },
      include: {
        entity: {
          include: { _count: { select: { assets: true } } },
        },
      },
    })
  );
}
