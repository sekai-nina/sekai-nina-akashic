"use client";

import { useState, useTransition } from "react";
import { Plus, X } from "lucide-react";
import { addExternalLinkAction } from "../actions";

export function ExternalLinkForm({ dossierId }: { dossierId: string }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [caption, setCaption] = useState("");
  const [note, setNote] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit() {
    if (!url) return;
    const fd = new FormData();
    fd.set("url", url);
    fd.set("caption", caption);
    fd.set("note", note);
    startTransition(async () => {
      await addExternalLinkAction(dossierId, fd);
      setUrl("");
      setCaption("");
      setNote("");
      setOpen(false);
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline"
      >
        <Plus className="h-3.5 w-3.5" /> 外部リンク
      </button>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3 w-full">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-slate-600">外部リンクを追加</h3>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-slate-400 hover:text-slate-600"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="space-y-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://..."
          className="w-full border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
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
        <div className="flex justify-end">
          <button
            type="button"
            onClick={submit}
            disabled={!url || isPending}
            className="bg-indigo-600 text-white px-3 py-1 rounded text-xs font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            追加
          </button>
        </div>
      </div>
    </div>
  );
}
