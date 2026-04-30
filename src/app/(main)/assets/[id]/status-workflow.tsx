"use client";

import { useOptimistic, useTransition } from "react";
import { updateAssetStatus } from "@/lib/actions";
import { ASSET_STATUS_LABELS } from "@/lib/utils";

const STATUS_WORKFLOW = [
  { from: "inbox", to: "triaging" as const, label: "整理中へ" },
  { from: "triaging", to: "organized" as const, label: "整理済みへ" },
  { from: "triaging", to: "inbox" as const, label: "Inboxに戻す" },
  { from: "organized", to: "archived" as const, label: "アーカイブ" },
  { from: "organized", to: "triaging" as const, label: "整理中に戻す" },
  { from: "archived", to: "organized" as const, label: "整理済みに戻す" },
];

const statusColors: Record<string, string> = {
  inbox: "bg-yellow-100 text-yellow-800",
  triaging: "bg-blue-100 text-blue-800",
  organized: "bg-green-100 text-green-800",
  archived: "bg-slate-100 text-slate-600",
};

export function StatusWorkflow({ assetId, initialStatus }: { assetId: string; initialStatus: string }) {
  const [optimisticStatus, setOptimisticStatus] = useOptimistic(initialStatus);
  const [, startTransition] = useTransition();

  const transitions = STATUS_WORKFLOW.filter((t) => t.from === optimisticStatus);

  function handleChange(to: "inbox" | "triaging" | "organized" | "archived") {
    startTransition(async () => {
      setOptimisticStatus(to);
      await updateAssetStatus(assetId, to);
    });
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-sm font-semibold text-slate-700">ステータス</h2>
        <span className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs font-medium ${statusColors[optimisticStatus] ?? "bg-slate-100 text-slate-600"}`}>
          {ASSET_STATUS_LABELS[optimisticStatus] ?? optimisticStatus}
        </span>
      </div>
      {transitions.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {transitions.map((t) => (
            <button
              key={t.to}
              type="button"
              onClick={() => handleChange(t.to)}
              className="border border-slate-300 text-slate-700 px-3 py-1.5 rounded text-sm hover:bg-slate-50 transition-colors"
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
