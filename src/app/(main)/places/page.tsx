import { auth } from "@/lib/auth";
import { getCachedPlaces } from "@/lib/cache";
import Link from "next/link";
import { MapPin, Plus, ExternalLink } from "lucide-react";
import { notFound } from "next/navigation";
import { PlacesMap } from "./places-map";

export default async function PlacesPage() {
  const session = await auth();
  if (!session?.user) notFound();

  const places = await getCachedPlaces(session.user.clearance as "public" | "internal" | "confidential" | "restricted");

  const markers = places.map((p) => ({
    id: p.id,
    lat: p.latitude,
    lng: p.longitude,
    label: p.entity.canonicalName,
    popupHtml: `<strong>${p.entity.canonicalName}</strong>${p.entity.description ? `<br/><span style="font-size:12px">${p.entity.description}</span>` : ""}`,
  }));

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <MapPin className="h-6 w-6 text-green-600" />
            聖地マップ
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            全 {places.length} 件の聖地
          </p>
        </div>
        <Link
          href="/places/new"
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors"
        >
          <Plus className="h-4 w-4" />
          新規登録
        </Link>
      </div>

      {/* Map */}
      <div className="mb-8">
        <PlacesMap markers={markers} />
      </div>

      {/* List */}
      <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
        {places.length === 0 && (
          <div className="px-4 py-8 text-center text-slate-400 text-sm">
            聖地が登録されていません
          </div>
        )}
        {places.map((place) => (
          <Link
            key={place.id}
            href={`/places/${place.id}`}
            className="flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors"
          >
            <div className="min-w-0">
              <span className="text-sm font-medium text-slate-900">
                {place.entity.canonicalName}
              </span>
              {place.entity.description && (
                <p className="text-xs text-slate-500 mt-0.5 truncate max-w-md">
                  {place.entity.description}
                </p>
              )}
              {place.address && (
                <p className="text-xs text-slate-400 mt-0.5">
                  {place.address}
                </p>
              )}
            </div>
            <div className="shrink-0 ml-4 flex items-center gap-3 text-right">
              {place.googleMapsUrl && (
                <span className="text-green-600">
                  <ExternalLink className="h-3.5 w-3.5" />
                </span>
              )}
              <span className="text-xs text-slate-400">
                {place.entity._count.assets} assets
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
