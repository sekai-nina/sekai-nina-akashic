"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { ASSET_KIND_LABELS, TRUST_LEVEL_LABELS } from "@/lib/utils";
import Link from "next/link";
import { Upload, X, Loader2, ChevronDown } from "lucide-react";

export default function NewAssetPage() {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setFiles((prev) => [...prev, ...Array.from(e.dataTransfer.files)]);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) {
      setFiles((prev) => [...prev, ...Array.from(e.target.files!)]);
    }
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");

    const form = e.currentTarget;
    const formData = new FormData(form);
    const title = formData.get("title") as string;
    const kind = formData.get("kind") as string;

    if (files.length > 0) {
      // File upload mode
      setUploading(true);
      const results: string[] = [];

      for (const file of files) {
        const uploadData = new FormData();
        uploadData.set("file", file);
        uploadData.set("title", title || file.name);
        if (kind) uploadData.set("kind", kind);

        const canonicalDate = formData.get("canonicalDate") as string;
        if (canonicalDate) uploadData.set("canonicalDate", canonicalDate);

        try {
          const res = await fetch("/api/upload", {
            method: "POST",
            body: uploadData,
          });
          const json = await res.json();
          if (!res.ok) {
            setError(json.error || "アップロードに失敗しました");
            break;
          }
          results.push(json.duplicate ? json.existingId : json.id);
        } catch {
          setError("アップロード中にエラーが発生しました");
          break;
        }
      }

      setUploading(false);
      if (results.length === 1) {
        router.push(`/assets/${results[0]}`);
      } else if (results.length > 1) {
        router.push("/inbox");
        router.refresh();
      }
    } else {
      // No file — submit as server action via fetch
      setUploading(true);
      try {
        const res = await fetch("/api/quick-create", {
          method: "POST",
          body: formData,
        });
        if (res.redirected) {
          router.push(res.url);
          return;
        }
        // Fallback: submit the form normally
        form.action = "/api/quick-create";
        form.method = "POST";
        form.submit();
      } catch {
        // Fallback: submit the form normally
        form.action = "/api/quick-create";
        form.method = "POST";
        form.submit();
      } finally {
        setUploading(false);
      }
    }
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/assets"
          className="text-slate-400 hover:text-slate-600 text-sm"
        >
          ← アセット一覧
        </Link>
        <span className="text-slate-300">/</span>
        <h1 className="text-xl font-bold text-slate-900">新規アセット登録</h1>
      </div>

      <form
        onSubmit={handleSubmit}
        className="bg-white border border-slate-200 rounded-lg p-6 space-y-5"
      >
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
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        {/* Title */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            タイトル{files.length > 0 ? "（省略時はファイル名）" : ""}
          </label>
          <input
            type="text"
            name="title"
            className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="タイトルを入力"
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            説明
          </label>
          <textarea
            name="description"
            rows={3}
            className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="説明を入力"
          />
        </div>

        {/* Canonical date */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            基準日
          </label>
          <input
            type="date"
            name="canonicalDate"
            className="border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* File upload */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            ファイル
          </label>
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-slate-300 rounded-lg p-4 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 transition-colors"
          >
            <Upload size={20} className="mx-auto text-slate-400 mb-1" />
            <p className="text-sm text-slate-500">
              ファイルをドラッグ＆ドロッ���、またはクリックして選択
            </p>
            <p className="text-xs text-slate-400 mt-0.5">複数ファイル選択可</p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileChange}
              className="hidden"
            />
          </div>
          {files.length > 0 && (
            <div className="mt-2 space-y-1">
              {files.map((file, i) => (
                <div
                  key={`${file.name}-${i}`}
                  className="flex items-center gap-2 bg-slate-50 rounded px-2 py-1 text-sm"
                >
                  {file.type.startsWith("image/") && (
                    <img
                      src={URL.createObjectURL(file)}
                      alt=""
                      className="w-8 h-8 object-cover rounded"
                    />
                  )}
                  <span className="flex-1 truncate text-slate-700">
                    {file.name}
                  </span>
                  <span className="text-xs text-slate-400">
                    {(file.size / 1024).toFixed(0)} KB
                  </span>
                  <button
                    type="button"
                    onClick={() => removeFile(i)}
                    className="text-slate-400 hover:text-red-500"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Advanced settings toggle */}
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700"
        >
          <ChevronDown
            size={14}
            className={`transition-transform ${showAdvanced ? "rotate-180" : ""}`}
          />
          詳細設定
        </button>

        {showAdvanced && (
          <div className="space-y-5 border-t border-slate-100 pt-5">
            {/* Trust level */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                信頼度
              </label>
              <select
                name="trustLevel"
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {Object.entries(TRUST_LEVEL_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            {/* Storage URL */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                ストレージURL
              </label>
              <input
                type="url"
                name="storageUrl"
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="https://..."
              />
            </div>

            {/* Storage provider */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                ストレージプロバイダー
              </label>
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
              <label className="block text-sm font-medium text-slate-700 mb-1">
                元ファイル名
              </label>
              <input
                type="text"
                name="originalFilename"
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="example.jpg"
              />
            </div>

            {/* MIME type */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                MIMEタイプ
              </label>
              <input
                type="text"
                name="mimeType"
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="image/jpeg"
              />
            </div>

            {/* File size */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                ファイルサイズ（バイト）
              </label>
              <input
                type="number"
                name="fileSize"
                min="0"
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Source type */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                ソース種別
              </label>
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
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={uploading}
            className="bg-blue-600 text-white px-6 py-2 rounded text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {uploading ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                処理中…
              </>
            ) : (
              "登録する"
            )}
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
