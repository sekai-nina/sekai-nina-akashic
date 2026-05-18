"use client";

import { useState } from "react";
import { Clipboard, Check } from "lucide-react";

export function CopyYamlButton({ yaml }: { yaml: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(yaml).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs border border-slate-300 hover:bg-slate-50 text-slate-700"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Clipboard className="h-3.5 w-3.5" />}
      {copied ? "コピー済み" : "YAMLをコピー"}
    </button>
  );
}
