"use client";

import { useOptimistic, useTransition } from "react";
import { updateAssetStatus } from "@/lib/actions";
import { ASSET_KIND_LABELS, ASSET_STATUS_LABELS, formatDate } from "@/lib/utils";
import Link from "next/link";

interface InboxAsset {
  id: string;
  title: string;
  kind: string;
  status: string;
  createdAt: string; // serialized
  sourceKind?: string;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    inbox: "bg-yellow-100 text-yellow-800",
    triaging: "bg-blue-100 text-blue-800",
    organized: "bg-green-100 text-green-800",
    archived: "bg-slate-100 text-slate-600",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors[status] ?? "bg-slate-100 text-slate-600"}`}>
      {ASSET_STATUS_LABELS[status] ?? status}
    </span>
  );
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">
      {ASSET_KIND_LABELS[kind] ?? kind}
    </span>
  );
}

export function InboxList({ assets }: { assets: InboxAsset[] }) {
  const [optimisticAssets, removeAsset] = useOptimistic(
    assets,
    (state, removedId: string) => state.filter((a) => a.id !== removedId)
  );
  const [, startTransition] = useTransition();

  function handleStatusChange(id: string, status: "triaging" | "organized") {
    startTransition(async () => {
      removeAsset(id);
      await updateAssetStatus(id, status);
    });
  }

  if (optimisticAssets.length === 0) {
    return (
      <div className="text-center py-16 text-slate-400">
        <p className="text-lg">Inboxは空です</p>
        <p className="text-sm mt-1">上のフォームからアセットを登録してください</p>
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
      {optimisticAssets.map((asset) => (
        <div key={asset.id} className="px-4 py-3 hover:bg-slate-50 space-y-2">
          <Link
            href={`/assets/${asset.id}`}
            className="text-sm font-medium text-slate-900 hover:text-blue-700 truncate block"
          >
            {asset.title || "(無題)"}
          </Link>
          <div className="flex items-center gap-2 flex-wrap">
            <KindBadge kind={asset.kind} />
            <StatusBadge status={asset.status} />
            <span className="text-xs text-slate-400">
              {formatDate(new Date(asset.createdAt))}
            </span>
            {asset.sourceKind && (
              <span className="text-xs text-slate-400">{asset.sourceKind}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleStatusChange(asset.id, "triaging")}
              className="text-xs border border-blue-300 text-blue-700 px-2 py-1 rounded hover:bg-blue-50 transition-colors"
            >
              整理中へ
            </button>
            <button
              type="button"
              onClick={() => handleStatusChange(asset.id, "organized")}
              className="text-xs border border-green-300 text-green-700 px-2 py-1 rounded hover:bg-green-50 transition-colors"
            >
              整理済みへ
            </button>
            <Link
              href={`/assets/${asset.id}`}
              className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1 ml-auto"
            >
              詳細
            </Link>
          </div>
        </div>
      ))}
    </div>
  );
}
