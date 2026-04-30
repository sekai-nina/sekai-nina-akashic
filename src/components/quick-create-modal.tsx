"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { ASSET_KIND_LABELS } from "@/lib/utils";
import { Upload, X, Loader2, Plus, ExternalLink } from "lucide-react";
import Link from "next/link";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function QuickCreateModal() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("image");
  const [files, setFiles] = useState<File[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [createdAssetId, setCreatedAssetId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setKind("image");
    setFiles([]);
    setTags([]);
    setTagInput("");
    setError("");
    setUploading(false);
    setCreatedAssetId(null);
  }

  function handleOpen() {
    reset();
    setOpen(true);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setFiles((prev) => [...prev, ...Array.from(e.dataTransfer.files)]);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) {
      setFiles((prev) => [...prev, ...Array.from(e.target.files!)]);
    }
  }

  function addTag() {
    const t = tagInput.trim();
    if (t && !tags.includes(t)) {
      setTags((prev) => [...prev, t]);
    }
    setTagInput("");
  }

  function handleTagKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag();
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const formData = new FormData(e.currentTarget);
    const title = formData.get("title") as string;
    const canonicalDate = formData.get("canonicalDate") as string;
    const bodyText = formData.get("bodyText") as string;

    if (files.length === 0 && !title) {
      setError("タイトルまたはファイルを入力してください");
      return;
    }

    setUploading(true);

    const entitiesJson = tags.length > 0
      ? JSON.stringify(tags.map((t) => ({ type: "tag", canonicalName: t })))
      : undefined;

    const textsJson = bodyText?.trim()
      ? JSON.stringify([{ textType: "body", content: bodyText.trim() }])
      : undefined;

    if (files.length > 0) {
      const results: string[] = [];
      for (const file of files) {
        const uploadData = new FormData();
        uploadData.set("file", file);
        uploadData.set("title", title || file.name);
        uploadData.set("kind", kind);
        if (canonicalDate) uploadData.set("canonicalDate", canonicalDate);
        if (entitiesJson) uploadData.set("entities", entitiesJson);
        if (textsJson) uploadData.set("texts", textsJson);

        try {
          const res = await fetch("/api/upload", { method: "POST", body: uploadData });
          const json = await res.json();
          if (!res.ok) { setError(json.error || "アップロードに失敗しました"); break; }
          results.push(json.duplicate ? json.existingId : json.id);
        } catch {
          setError("アップロード中にエラーが発生しました");
          break;
        }
      }

      setUploading(false);
      if (results.length > 0) {
        setCreatedAssetId(results[0]);
      }
    } else {
      const uploadData = new FormData();
      uploadData.set("title", title);
      uploadData.set("kind", kind);
      if (canonicalDate) uploadData.set("canonicalDate", canonicalDate);
      if (bodyText?.trim()) uploadData.set("bodyText", bodyText.trim());
      if (entitiesJson) uploadData.set("entities", entitiesJson);
      if (textsJson) uploadData.set("texts", textsJson);

      try {
        const res = await fetch("/api/quick-create", { method: "POST", body: uploadData });
        const json = await res.json();
        if (res.ok && json.id) {
          setCreatedAssetId(json.id);
        } else {
          setError(json.error || "登録に失敗しました");
        }
      } catch {
        setError("登録中にエラーが発生しました");
      } finally {
        setUploading(false);
      }
    }
  }

  const showBodyField = kind === "text" || kind === "document";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* Desktop sidebar button */}
      <button
        type="button"
        onClick={handleOpen}
        className="hidden md:flex items-center justify-center gap-1.5 w-full bg-blue-600 text-white rounded-md py-1.5 text-sm font-medium hover:bg-blue-700 transition-colors"
      >
        <Plus size={14} />
        新規登録
      </button>

      {/* Mobile header button */}
      <button
        type="button"
        onClick={handleOpen}
        className="md:hidden ml-auto p-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
      >
        <Plus size={16} />
      </button>

      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>新規アセット登録</DialogTitle>
        </DialogHeader>

        {createdAssetId ? (
          /* Success state */
          <div className="space-y-4 text-center py-4">
            <p className="text-sm text-slate-600">アセットを登録しました</p>
            <div className="flex items-center justify-center gap-3">
              <Link
                href={`/assets/${createdAssetId}`}
                onClick={() => setOpen(false)}
                className="inline-flex items-center gap-1.5 bg-blue-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-blue-700 transition-colors"
              >
                <ExternalLink size={14} />
                アセットを開く
              </Link>
              <button
                type="button"
                onClick={() => { reset(); }}
                className="text-sm border border-slate-300 text-slate-600 px-4 py-2 rounded hover:bg-slate-50 transition-colors"
              >
                続けて登録
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-sm text-slate-500 hover:text-slate-700"
              >
                閉じる
              </button>
            </div>
          </div>
        ) : (
          /* Form */
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">種別</label>
              <select
                name="kind"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {Object.entries(ASSET_KIND_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                タイトル{files.length > 0 ? "（省略時はファイル名）" : ""}
              </label>
              <input
                type="text"
                name="title"
                placeholder="タイトルを入力"
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Body text — shown for text/document kinds */}
            {showBodyField && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">本文</label>
                <textarea
                  name="bodyText"
                  rows={5}
                  placeholder="本文を入力（セミコロン区切りなど）"
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">日付</label>
              <input
                type="date"
                name="canonicalDate"
                className="border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Tags */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">タグ</label>
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-700"
                    >
                      {tag}
                      <button
                        type="button"
                        onClick={() => setTags((prev) => prev.filter((t) => t !== tag))}
                        className="text-slate-400 hover:text-red-500"
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={handleTagKeyDown}
                  placeholder="タグ名を入力してEnter"
                  className="flex-1 border border-slate-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={addTag}
                  className="text-sm text-slate-600 border border-slate-300 px-2.5 py-1.5 rounded hover:bg-slate-50 transition-colors"
                >
                  追加
                </button>
              </div>
            </div>

            {/* File upload */}
            <div>
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-slate-300 rounded-lg p-3 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 transition-colors"
              >
                <Upload size={18} className="mx-auto text-slate-400 mb-1" />
                <p className="text-sm text-slate-500">ファイルをドラッグ＆ドロップ</p>
                <p className="text-xs text-slate-400">またはクリックして選択</p>
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
                    <div key={`${file.name}-${i}`} className="flex items-center gap-2 bg-slate-50 rounded px-2 py-1 text-sm">
                      <span className="flex-1 truncate text-slate-700">{file.name}</span>
                      <span className="text-xs text-slate-400">{(file.size / 1024).toFixed(0)} KB</span>
                      <button
                        type="button"
                        onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                        className="text-slate-400 hover:text-red-500"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <div className="flex items-center gap-3 pt-1">
              <button
                type="submit"
                disabled={uploading}
                className="bg-blue-600 text-white px-5 py-2 rounded text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {uploading ? <><Loader2 size={14} className="animate-spin" />処理中…</> : "登録する"}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-sm text-slate-500 hover:text-slate-700"
              >
                キャンセル
              </button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
