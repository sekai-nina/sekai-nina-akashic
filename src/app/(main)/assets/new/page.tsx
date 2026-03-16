import { createAsset } from "@/lib/actions";
import { ASSET_KIND_LABELS, TRUST_LEVEL_LABELS } from "@/lib/utils";
import Link from "next/link";

export default function NewAssetPage() {
  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6 flex items-center gap-3">
        <Link href="/assets" className="text-slate-400 hover:text-slate-600 text-sm">
          ← アセット一覧
        </Link>
        <span className="text-slate-300">/</span>
        <h1 className="text-xl font-bold text-slate-900">新規アセット登録</h1>
      </div>

      <form action={createAsset} className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        {/* Kind */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            種別 <span className="text-red-500">*</span>
          </label>
          <select
            name="kind"
            className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
          >
            {Object.entries(ASSET_KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>

        {/* Title */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">タイトル</label>
          <input
            type="text"
            name="title"
            className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="タイトルを入力"
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">説明</label>
          <textarea
            name="description"
            rows={3}
            className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="説明を入力"
          />
        </div>

        {/* Canonical date */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">基準日</label>
          <input
            type="date"
            name="canonicalDate"
            className="border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Trust level */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">信頼度</label>
          <select
            name="trustLevel"
            className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {Object.entries(TRUST_LEVEL_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>

        {/* Storage URL */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">ストレージURL</label>
          <input
            type="url"
            name="storageUrl"
            className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="https://..."
          />
        </div>

        {/* Storage provider */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">ストレージプロバイダー</label>
          <select
            name="storageProvider"
            className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="local_none">なし</option>
            <option value="external_url">外部URL</option>
            <option value="gdrive">Google Drive</option>
            <option value="discord_url">Discord URL</option>
          </select>
        </div>

        {/* Original filename */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">元ファイル名</label>
          <input
            type="text"
            name="originalFilename"
            className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="example.jpg"
          />
        </div>

        {/* MIME type */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">MIMEタイプ</label>
          <input
            type="text"
            name="mimeType"
            className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="image/jpeg"
          />
        </div>

        {/* File size */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">ファイルサイズ（バイト）</label>
          <input
            type="number"
            name="fileSize"
            min="0"
            className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Source type */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">ソース種別</label>
          <select
            name="sourceType"
            className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="manual">手動</option>
            <option value="web">Web</option>
            <option value="discord">Discord</option>
            <option value="import">インポート</option>
          </select>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            className="bg-blue-600 text-white px-6 py-2 rounded text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            登録する
          </button>
          <Link
            href="/assets"
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            キャンセル
          </Link>
        </div>
      </form>
    </div>
  );
}
