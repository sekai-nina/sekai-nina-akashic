"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { ASSET_KIND_LABELS } from "@/lib/utils";
import { Upload, X, Loader2 } from "lucide-react";

export function QuickUploadForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"url" | "file">("file");
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [duplicateWarning, setDuplicateWarning] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setDuplicateWarning("");

    const form = e.currentTarget;
    const formData = new FormData(form);

    if (mode === "url") {
      // Use the existing server action via standard form submission
      form.action = "";
      form.submit();
      return;
    }

    // File upload mode
    if (files.length === 0) {
      setError("ファイルを選択してください");
      return;
    }

    setUploading(true);
    const title = formData.get("title") as string;
    const kind = formData.get("kind") as string;
    const results: string[] = [];
    const duplicates: string[] = [];

    for (const file of files) {
      const uploadData = new FormData();
      uploadData.set("file", file);
      uploadData.set("title", title || file.name);
      if (kind) uploadData.set("kind", kind);

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

        if (json.duplicate) {
          duplicates.push(json.message);
          results.push(json.existingId);
        } else {
          results.push(json.id);
        }
      } catch {
        setError("アップロード中にエラーが発生しました");
        break;
      }
    }

    setUploading(false);

    if (duplicates.length > 0) {
      setDuplicateWarning(duplicates.join("\n"));
    }

    if (results.length > 0) {
      if (results.length === 1) {
        router.push(`/assets/${results[0]}`);
      } else {
        router.push("/inbox");
        router.refresh();
      }
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const dropped = Array.from(e.dataTransfer.files);
    setFiles((prev) => [...prev, ...dropped]);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) {
      setFiles((prev) => [...prev, ...Array.from(e.target.files!)]);
    }
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-slate-700">クイック登録</h2>
        <div className="flex gap-1 text-xs">
          <button
            type="button"
            onClick={() => setMode("file")}
            className={`px-2 py-1 rounded ${mode === "file" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
          >
            ファイル
          </button>
          <button
            type="button"
            onClick={() => setMode("url")}
            className={`px-2 py-1 rounded ${mode === "url" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
          >
            URL
          </button>
        </div>
      </div>

      <form onSubmit={handleSubmit} action="/api/quick-create">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs text-slate-500 mb-1">タイトル{mode === "file" ? "（省略時はファイル名）" : ""}</label>
            <input
              type="text"
              name="title"
              placeholder="タイトルを入力"
              className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              required={mode === "url"}
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">種別</label>
            <select
              name="kind"
              className="border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">自動判別</option>
              {Object.entries(ASSET_KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          {mode === "url" && (
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs text-slate-500 mb-1">URL</label>
              <input
                type="url"
                name="storageUrl"
                placeholder="https://..."
                className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={uploading}
            className="bg-blue-600 text-white px-4 py-1.5 rounded text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {uploading ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                アップロード中…
              </>
            ) : (
              "登録"
            )}
          </button>
        </div>

        {mode === "file" && (
          <div className="mt-3">
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-slate-300 rounded-lg p-4 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 transition-colors"
            >
              <Upload size={20} className="mx-auto text-slate-400 mb-1" />
              <p className="text-sm text-slate-500">
                ファイルをドラッグ＆ドロップ、またはクリックして選択
              </p>
              <p className="text-xs text-slate-400 mt-0.5">
                複数ファイル選択可
              </p>
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
                    <span className="flex-1 truncate text-slate-700">{file.name}</span>
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
        )}
      </form>

      {error && (
        <p className="mt-2 text-sm text-red-600">{error}</p>
      )}
      {duplicateWarning && (
        <p className="mt-2 text-sm text-amber-600">{duplicateWarning}</p>
      )}
    </div>
  );
}
