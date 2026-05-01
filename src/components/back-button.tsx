"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

export function BackButton() {
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={() => router.back()}
      className="flex items-center gap-1 text-sm text-slate-400 hover:text-slate-600 shrink-0 whitespace-nowrap"
    >
      <ArrowLeft size={14} />
      戻る
    </button>
  );
}
