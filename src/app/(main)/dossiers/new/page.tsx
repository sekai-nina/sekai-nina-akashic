import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { SubmitButton } from "@/components/submit-button";
import { createDossierAction } from "../actions";

export default async function NewDossierPage() {
  const session = await auth();
  if (!session?.user) notFound();

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <Link href="/dossiers" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600">
        <ArrowLeft size={14} /> ドシエ一覧へ
      </Link>
      <h1 className="text-xl font-bold tracking-tight mt-3 mb-4">新規ドシエ</h1>
      <form action={createDossierAction} className="space-y-4 bg-white border border-slate-200 rounded-lg p-5">
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">タイトル</label>
          <input
            name="title"
            required
            className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            placeholder="例: 2024-09-15 メンバーAとご飯"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">概要</label>
          <textarea
            name="summary"
            rows={3}
            className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            placeholder="何を特定/整理したいかを書いておくと後で見返しやすい"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">クリアランス</label>
            <select
              name="classification"
              defaultValue="internal"
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="internal">一般</option>
              <option value="confidential">限定</option>
              <option value="restricted">極秘</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">閲覧</label>
            <select
              name="viewMode"
              defaultValue="private"
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="private">自分のみ</option>
              <option value="clearance">クリアランス以上</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">編集</label>
            <select
              name="editMode"
              defaultValue="private"
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="private">自分のみ</option>
              <option value="clearance">クリアランス以上</option>
            </select>
          </div>
        </div>
        <div className="flex justify-end pt-2">
          <SubmitButton className="bg-indigo-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-indigo-700 transition-colors">
            作成
          </SubmitButton>
        </div>
      </form>
    </div>
  );
}
