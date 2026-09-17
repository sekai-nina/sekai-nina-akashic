"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { refetchReportsAction } from "../actions";

export function ReportsStep({ meetGreetId, hasCollection }: { meetGreetId: string; hasCollection: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  if (!hasCollection) return null;

  function refetch() {
    setMsg("収集中…");
    startTransition(async () => {
      const res = await refetchReportsAction(meetGreetId);
      setMsg(res.ok ? `${res.fetched} 件取得、${res.added} 件追加` : `エラー: ${res.error}`);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={refetch}
        disabled={pending}
        className="inline-flex items-center gap-1 h-8 px-3 rounded-md border border-slate-200 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        <RefreshCw size={12} className={pending ? "animate-spin" : ""} /> 再収集
      </button>
      {msg && <span className="text-xs text-slate-500">{msg}</span>}
    </div>
  );
}
