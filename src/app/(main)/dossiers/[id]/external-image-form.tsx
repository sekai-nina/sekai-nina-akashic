"use client";

import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { Plus, X, Image as ImageIcon, Loader2 } from "lucide-react";

export function ExternalImageForm({ dossierId }: { dossierId: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function pickFile(f: File) {
    setFile(f);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(f));
  }

  function reset() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl(null);
    setCaption("");
    setNote("");
    setError(null);
  }

  async function submit() {
    if (!file) return;
    setError(null);

    const fd = new FormData();
    fd.set("file", file);
    fd.set("caption", caption);
    fd.set("note", note);

    try {
      const res = await fetch(`/api/v1/dossiers/${dossierId}/external-image`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "アップロードに失敗しました");
        return;
      }
      reset();
      setOpen(false);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "アップロードに失敗しました");
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline"
      >
        <Plus className="h-3.5 w-3.5" /> 外部画像
      </button>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3 w-full">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-slate-600 flex items-center gap-1">
          <ImageIcon className="h-3.5 w-3.5" /> 外部画像をアップロード
        </h3>
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          className="text-slate-400 hover:text-slate-600"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {!previewUrl ? (
        <label className="block border-2 border-dashed border-slate-300 rounded-lg p-6 text-center cursor-pointer hover:border-indigo-400 hover:bg-slate-50 transition-colors">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) pickFile(f);
            }}
          />
          <ImageIcon className="h-6 w-6 mx-auto text-slate-400 mb-1" />
          <span className="text-xs text-slate-500">画像をクリックして選択 (最大 20MB)</span>
        </label>
      ) : (
        <div className="space-y-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt="" className="max-h-48 w-auto rounded border border-slate-200" />
          <input
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="見出し (任意)"
            className="w-full border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="メモ (任意)"
            rows={2}
            className="w-full border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          {error && <p className="text-[11px] text-rose-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={reset}
              className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1"
            >
              選び直す
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={isPending}
              className="inline-flex items-center gap-1 bg-indigo-600 text-white px-3 py-1 rounded text-xs font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
              アップロード
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
