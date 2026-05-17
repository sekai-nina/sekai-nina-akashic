import { auth } from "@/lib/auth";
import { getPlaceById } from "@/lib/domain/places";
import { withClearance } from "@/lib/db";
import { updatePlaceAction, deletePlaceAction } from "@/lib/actions";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, MapPin, ExternalLink, Trash2 } from "lucide-react";
import { SubmitButton } from "@/components/submit-button";
import { ASSET_KIND_LABELS, formatDate } from "@/lib/utils";
import { PlaceDetailMap } from "./place-detail-map";

export default async function PlaceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) notFound();

  const { id } = await params;
  const place = await getPlaceById(id, session.user.clearance);
  if (!place) notFound();

  // Get linked assets via AssetEntity
  const linkedAssets = await withClearance(session.user.clearance, (tx) =>
    tx.assetEntity.findMany({
      where: { entityId: place.entityId },
      include: { asset: { select: { id: true, title: true, kind: true, canonicalDate: true, thumbnailUrl: true } } },
      orderBy: { createdAt: "desc" },
      take: 50,
    })
  ) as Array<{ id: string; createdAt: Date; asset: { id: string; title: string; kind: string; canonicalDate: Date | null; thumbnailUrl: string | null } }>;

  const canEdit = ["admin", "member"].includes(session.user.role);

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/places"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-3"
        >
          <ArrowLeft className="h-4 w-4" />
          聖地一覧に戻る
        </Link>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
              <MapPin className="h-6 w-6 text-green-600" />
              {place.entity.canonicalName}
            </h1>
            {place.entity.description && (
              <p className="text-slate-600 mt-1">{place.entity.description}</p>
            )}
          </div>
          {place.googleMapsUrl && (
            <a
              href={place.googleMapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-green-700 bg-green-50 hover:bg-green-100 rounded-lg transition-colors"
            >
              <ExternalLink className="h-4 w-4" />
              Google Maps
            </a>
          )}
        </div>
      </div>

      {/* Map */}
      <div className="mb-6">
        <PlaceDetailMap
          lat={place.latitude}
          lng={place.longitude}
          label={place.entity.canonicalName}
        />
      </div>

      {/* Info */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h3 className="text-xs font-medium text-slate-500 uppercase mb-2">座標</h3>
          <p className="text-sm text-slate-900 font-mono">
            {place.latitude.toFixed(6)}, {place.longitude.toFixed(6)}
          </p>
        </div>
        {place.address && (
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <h3 className="text-xs font-medium text-slate-500 uppercase mb-2">住所</h3>
            <p className="text-sm text-slate-900">{place.address}</p>
          </div>
        )}
      </div>

      {/* Linked Assets */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold text-slate-900 mb-3">
          紐付きアセット ({linkedAssets.length})
        </h2>
        {linkedAssets.length === 0 ? (
          <p className="text-sm text-slate-400">紐付きアセットはまだありません</p>
        ) : (
          <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
            {linkedAssets.map((ae) => (
              <Link
                key={ae.id}
                href={`/assets/${ae.asset.id}`}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 transition-colors"
              >
                {ae.asset.thumbnailUrl && (
                  <img
                    src={ae.asset.thumbnailUrl}
                    alt=""
                    className="w-10 h-10 rounded object-cover shrink-0"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <span className="text-sm text-slate-900 truncate block">
                    {ae.asset.title || "(無題)"}
                  </span>
                  <span className="text-xs text-slate-400">
                    {ASSET_KIND_LABELS[ae.asset.kind] ?? ae.asset.kind}
                    {ae.asset.canonicalDate && ` / ${formatDate(ae.asset.canonicalDate)}`}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Edit Form */}
      {canEdit && (
        <div className="border border-slate-200 rounded-lg p-4 bg-white">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">編集</h2>
          <form action={updatePlaceAction.bind(null, place.id)} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">名前</label>
              <input
                type="text"
                name="name"
                defaultValue={place.entity.canonicalName}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">緯度</label>
                <input
                  type="number"
                  name="latitude"
                  step="any"
                  defaultValue={place.latitude}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">経度</label>
                <input
                  type="number"
                  name="longitude"
                  step="any"
                  defaultValue={place.longitude}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Google Maps URL</label>
              <input
                type="url"
                name="googleMapsUrl"
                defaultValue={place.googleMapsUrl ?? ""}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">住所</label>
              <input
                type="text"
                name="address"
                defaultValue={place.address ?? ""}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">説明</label>
              <textarea
                name="description"
                defaultValue={place.entity.description ?? ""}
                rows={3}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
            <SubmitButton
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
              pendingText="保存中..."
            >
              保存
            </SubmitButton>
          </form>

          {/* Delete */}
          <div className="mt-6 pt-4 border-t border-slate-200">
            <form action={deletePlaceAction.bind(null, place.id)}>
              <SubmitButton
                className="px-4 py-2 text-sm font-medium text-red-600 border border-red-200 hover:bg-red-50 rounded-lg"
                pendingText="削除中..."
              >
                <Trash2 className="h-4 w-4" />
                この聖地を削除
              </SubmitButton>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
