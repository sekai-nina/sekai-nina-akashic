"use client";

import { useState } from "react";

export function CopySourceRef({
  assetId,
  title,
  canonicalDate,
}: {
  assetId: string;
  title: string;
  canonicalDate: string | null;
}) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    const dateLine = canonicalDate
      ? `\n    date: ${canonicalDate.slice(0, 10)}`
      : "";
    const snippet = `  - id: _\n    ref: ${assetId}\n    label: ${title}${dateLine}`;

    navigator.clipboard.writeText(snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <button
      onClick={handleCopy}
      className="shrink-0 border border-slate-300 text-slate-700 px-3 py-1.5 rounded text-sm hover:bg-slate-50 transition-colors"
    >
      {copied ? "コピー済み ✓" : "出典コピー"}
    </button>
  );
}
