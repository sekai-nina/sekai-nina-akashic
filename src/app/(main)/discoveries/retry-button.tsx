"use client";

import { useState, useTransition } from "react";
import { retryGivenUpAction } from "./actions";

/** cron があきらめたブログを、もう一度 cron に試させる */
export function RetryButton({ assetId }: { assetId: string }) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const res = await retryGivenUpAction(assetId);
            setMsg(res.ok ? "次の cron で試します" : `エラー: ${res.error}`);
          })
        }
        className="px-2 py-1 rounded-md border border-amber-300 bg-white text-xs text-amber-800 hover:bg-amber-50 disabled:opacity-50"
      >
        もう一度試す
      </button>
      {msg && <span className="text-xs text-slate-500">{msg}</span>}
    </span>
  );
}
