"use client";

import { useState, useTransition } from "react";
import { Bell, Loader2, RefreshCw } from "lucide-react";
import { evaluateNowAction, testNotificationAction, type StatusActionState } from "./actions";

/**
 * admin だけに出す操作。「今すぐ評価」は cron と同じ処理 (Discord にも流れる)、
 * 「通知テスト」は webhook の疎通だけ。結果は下に 1 行で出す。
 */
export function AdminControls({ discordConfigured }: { discordConfigured: boolean }) {
  const [state, setState] = useState<StatusActionState | null>(null);
  const [isPending, startTransition] = useTransition();

  function run(action: () => Promise<StatusActionState>) {
    if (isPending) return;
    startTransition(async () => setState(await action()));
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => run(evaluateNowAction)}
        disabled={isPending}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
      >
        {isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        今すぐ評価
      </button>
      <button
        type="button"
        onClick={() => run(testNotificationAction)}
        disabled={isPending || !discordConfigured}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
      >
        <Bell size={14} />
        通知テスト
      </button>
      {!discordConfigured && (
        <span className="text-xs text-slate-400">
          <span className="font-mono">DISCORD_STATUS_WEBHOOK_URL</span> が未設定のため通知は送られません
        </span>
      )}
      {state && (
        <span className={`text-xs ${state.ok ? "text-emerald-700" : "text-red-700"}`}>
          {state.ok ? state.message : state.error}
        </span>
      )}
    </div>
  );
}
