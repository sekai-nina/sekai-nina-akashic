"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function CopyInviteLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleCopy}
      className="text-blue-600 hover:text-blue-800 inline-flex items-center gap-1"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? "コピー済み" : "リンクをコピー"}
    </button>
  );
}
