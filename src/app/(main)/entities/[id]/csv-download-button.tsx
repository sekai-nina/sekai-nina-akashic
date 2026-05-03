"use client";

import { useState } from "react";
import { Download, Loader2, Check } from "lucide-react";

export function CsvDownloadButton({ href }: { href: string }) {
  const [state, setState] = useState<"idle" | "downloading" | "done">("idle");

  async function handleClick() {
    setState("downloading");
    try {
      const res = await fetch(href);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const disposition = res.headers.get("Content-Disposition");
      const match = disposition?.match(/filename="?(.+?)"?$/);
      a.download = match ? decodeURIComponent(match[1]) : "mentions.csv";
      a.click();
      URL.revokeObjectURL(url);
      setState("done");
      setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("idle");
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={state === "downloading"}
      className="flex items-center gap-1 text-xs border border-slate-300 text-slate-600 px-2.5 py-1 rounded hover:bg-slate-50 transition-colors disabled:opacity-70"
    >
      {state === "downloading" ? (
        <Loader2 size={12} className="animate-spin" />
      ) : state === "done" ? (
        <Check size={12} className="text-green-600" />
      ) : (
        <Download size={12} />
      )}
      {state === "downloading" ? "ダウンロード中…" : state === "done" ? "完了" : "CSV"}
    </button>
  );
}
