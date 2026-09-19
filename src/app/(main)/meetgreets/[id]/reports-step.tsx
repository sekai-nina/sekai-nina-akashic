"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { refetchReportsAction } from "../actions";

export function ReportsStep({
  meetGreetId,
  hasCollection,
  fetched,
}: {
  meetGreetId: string;
  hasCollection: boolean;
  /** 一度でも収集したか。まだなら「収集する」を主導線にする */
  fetched: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  if (!hasCollection) return null;

  function refetch() {
    setMsg("収集中… 1 分ほどかかることがあります");
    startTransition(async () => {
      const res = await refetchReportsAction(meetGreetId).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "通信に失敗しました",
      }));
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
        className={
          "inline-flex items-center gap-1 h-8 px-3 rounded-md text-xs disabled:opacity-50 " +
          (fetched
            ? "border border-slate-200 text-slate-700 hover:bg-slate-50"
            : "bg-slate-900 text-white hover:bg-slate-800")
        }
      >
        <RefreshCw size={12} className={pending ? "animate-spin" : ""} />
        {fetched ? "再収集" : "X を収集する"}
      </button>
      {msg && <span className="text-xs text-slate-500">{msg}</span>}
    </div>
  );
}
