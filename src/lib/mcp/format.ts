import type { Prisma } from "@prisma/client";
import { toDateOnlyString } from "@/lib/domain/coverage";
import type { SearchResultItem } from "@/lib/search";

/**
 * MCP のツール結果に載せる射影。
 *
 * domain 層の戻り値をそのまま返すと thumbnailUrl / storageKey / sha256 /
 * normalizedContent などが全部乗ってコンテキストを食うので、AI が実際に使う
 * フィールドだけに間引く。id は後続ツール (get_asset / update_asset) の入力に
 * なるので必ず含める。
 */

/** アセット詳細に載せる本文の最大長 */
const TEXT_MAX_LENGTH = 4000;

/** リクエストから画面の URL を決める。AUTH_URL があればそれを優先する。 */
export function resolveAppBaseUrl(request: Request): string {
  const configured = process.env.AUTH_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");

  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost) {
    const host = forwardedHost.split(",")[0].trim();
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim() ?? "https";
    return `${proto}://${host}`;
  }

  try {
    return new URL(request.url).origin;
  } catch {
    return "";
  }
}

export function assetUrl(baseUrl: string, assetId: string): string {
  return baseUrl ? `${baseUrl}/assets/${assetId}` : "";
}

export function placeUrl(baseUrl: string, placeId: string): string {
  return baseUrl ? `${baseUrl}/places?place=${placeId}` : "";
}

/**
 * 実時刻 (publishedAt 等) を JST の "YYYY-MM-DD" で返す。
 *
 * `canonicalDate` は「YYYY-MM-DD の UTC 00:00」格納規約なので toDateOnlyString (UTC 切り) が正しいが、
 * `SourceRecord.publishedAt` は実時刻なので UTC で切ると JST 0〜9 時のデータが前日に落ちる。
 */
export function toJstDateOnly(d: Date | null | undefined): string | null {
  if (!d) return null;
  // en-CA ロケールは YYYY-MM-DD 形式を返す
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** 実時刻 (createdAt 等) を JST の "YYYY-MM-DD HH:mm" で返す。 */
export function formatJstDateTime(d: Date | null | undefined): string | null {
  if (!d) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function truncateText(content: string): string {
  if (content.length <= TEXT_MAX_LENGTH) return content;
  return `${content.slice(0, TEXT_MAX_LENGTH)}…(全 ${content.length} 文字中 ${TEXT_MAX_LENGTH} 文字まで)`;
}


/**
 * 射影の入力型。domain 側の include と揃えるため Prisma の生成型から導く。
 * 手書きすると enum 列が string に緩み、リレーションの付け忘れにも気づけない。
 * (`PlaceWithEntity` という名前は src/lib/domain/places.ts が別物で使っているので避ける)
 */
type AssetDetailInput = Prisma.AssetGetPayload<{
  include: {
    texts: true;
    entities: { include: { entity: true } };
    sourceRecords: true;
  };
}>;

type PlaceSummaryInput = Prisma.PlaceGetPayload<{
  include: { entity: { include: { _count: { select: { assets: true } } } } };
}>;

export function toSearchItem(item: SearchResultItem, baseUrl: string) {
  return {
    id: item.assetId,
    kind: item.assetKind,
    status: item.assetStatus,
    title: item.assetTitle,
    // canonicalDate は「YYYY-MM-DD の UTC 00:00」で格納される規約なので UTC 基準で切り出す
    date: toDateOnlyString(item.canonicalDate),
    matchedIn: item.matchField,
    snippets: item.snippets,
    bodyPreview: item.bodyPreview,
    persons: item.personNames,
    tags: item.tagNames,
    url: assetUrl(baseUrl, item.assetId),
  };
}


export function toAssetDetail(asset: AssetDetailInput, baseUrl: string) {
  return {
    id: asset.id,
    kind: asset.kind,
    status: asset.status,
    title: asset.title,
    description: asset.description,
    classification: asset.classification,
    trustLevel: asset.trustLevel,
    date: toDateOnlyString(asset.canonicalDate),
    sourceType: asset.sourceType,
    storageUrl: asset.storageUrl,
    discordMessageUrl: asset.discordMessageUrl,
    texts:
      asset.texts?.map((t) => ({
        textType: t.textType,
        language: t.language,
        content: truncateText(t.content),
      })) ?? [],
    entities:
      asset.entities?.map((ae) => ({
        id: ae.entity.id,
        type: ae.entity.type,
        name: ae.entity.canonicalName,
        role: ae.roleLabel,
      })) ?? [],
    sources:
      asset.sourceRecords?.map((s) => ({
        sourceKind: s.sourceKind,
        title: s.title,
        url: s.url,
        publisher: s.publisher,
        // publishedAt は実時刻なので JST 基準で日付にする (UTC 切りだと JST 0〜9 時が前日になる)
        publishedAt: toJstDateOnly(s.publishedAt),
      })) ?? [],
    createdAt: formatJstDateTime(asset.createdAt),
    updatedAt: formatJstDateTime(asset.updatedAt),
    url: assetUrl(baseUrl, asset.id),
  };
}

export function toEntitySummary(entity: {
  id: string;
  type: string;
  canonicalName: string;
  description?: string;
  generation?: number | null;
  reading?: string | null;
}) {
  return {
    id: entity.id,
    type: entity.type,
    name: entity.canonicalName,
    ...(entity.description ? { description: entity.description } : {}),
    ...(entity.generation != null ? { generation: entity.generation } : {}),
    ...(entity.reading ? { reading: entity.reading } : {}),
  };
}


export function toPlaceSummary(place: PlaceSummaryInput, baseUrl: string) {
  return {
    id: place.id,
    entityId: place.entityId,
    name: place.entity.canonicalName,
    description: place.entity.description,
    latitude: place.latitude,
    longitude: place.longitude,
    address: place.address,
    googleMapsUrl: place.googleMapsUrl,
    classification: place.classification,
    status: place.status,
    assetCount: place.entity._count?.assets ?? 0,
    url: placeUrl(baseUrl, place.id),
  };
}
