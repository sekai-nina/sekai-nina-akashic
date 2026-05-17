import { auth } from "@/lib/auth";
import { createPlaceAction } from "@/lib/actions";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, MapPin } from "lucide-react";
import { SubmitButton } from "@/components/submit-button";

export default async function NewPlacePage() {
  const session = await auth();
  if (!session?.user) notFound();
  if (!["admin", "member"].includes(session.user.role)) notFound();

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <Link
          href="/places"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-3"
        >
          <ArrowLeft className="h-4 w-4" />
          聖地一覧に戻る
        </Link>
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <MapPin className="h-6 w-6 text-green-600" />
          聖地を登録
        </h1>
      </div>

      <form action={createPlaceAction} className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            名前 <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            name="name"
            required
            placeholder="例: サニーヒルズ南青山"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              緯度 <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              name="latitude"
              step="any"
              required
              placeholder="35.6660"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              経度 <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              name="longitude"
              step="any"
              required
              placeholder="139.7167"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Google Maps URL
          </label>
          <input
            type="url"
            name="googleMapsUrl"
            placeholder="https://maps.app.goo.gl/..."
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">住所</label>
          <input
            type="text"
            name="address"
            placeholder="例: 東京都港区南青山3-10-20"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">説明</label>
          <textarea
            name="description"
            rows={3}
            placeholder="この聖地についての説明..."
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500"
          />
        </div>

        <div className="pt-2">
          <SubmitButton
            className="w-full px-4 py-2.5 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg justify-center"
            pendingText="登録中..."
          >
            登録する
          </SubmitButton>
        </div>
      </form>
    </div>
  );
}
