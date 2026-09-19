"use client";

import { useState, useTransition } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { runNowAction, type MentionActionState } from "./actions";

/**
 * 「今すぐ実行」と直近の実行結果。cron と同じ処理なので X API を叩き、ヒットがあれば Discord にも流れる。
 * 相対時刻はサーバーで文字列にしたものを受け取る (hydration のズレを避ける)
 */
export function RunControls({
  canEdit,
  discordConfigured,
  lastRun,
}: {
  canEdit: boolean;
  discordConfigured: boolean;
  lastRun: { relative: string; ok: boolean; message: string } | null;
}) {
  const [state, setState] = useState<MentionActionState | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    if (isPending) return;
    startTransition(async () => setState(await runNowAction()));
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {canEdit && (
          <button
            type="button"
            onClick={run}
            disabled={isPending}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
          >
            {isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            今すぐ実行
          </button>
        )}
        {!discordConfigured && (
          <span className="text-xs text-slate-400">
            <span className="font-mono">DISCORD_MENTION_WEBHOOK_URL</span> が未設定のため保存だけ行い通知は送られません
          </span>
        )}
        {state && (
          <span className={`text-xs ${state.ok ? "text-emerald-700" : "text-red-700"}`}>
            {state.ok ? state.message : state.error}
          </span>
        )}
      </div>
      <p className="text-xs text-slate-400">
        {lastRun ? (
          <>
            最終実行 {lastRun.relative}
            <span className={cn(!lastRun.ok && "text-red-600")}> ── {lastRun.message}</span>
          </>
        ) : (
          "まだ実行されていません"
        )}
      </p>
    </div>
  );
}
