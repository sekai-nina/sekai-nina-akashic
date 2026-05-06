"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ASSET_KIND_LABELS } from "@/lib/utils";

interface AssetNodeData {
  title: string;
  kind: string;
  thumbnailUrl: string | null;
  isCenter: boolean;
  [key: string]: unknown;
}

export function AssetNode({ data }: NodeProps) {
  const { title, kind, thumbnailUrl, isCenter } = data as AssetNodeData;

  return (
    <div
      className={`bg-white border-2 rounded-lg shadow-sm cursor-pointer hover:shadow-md transition-shadow w-[180px] overflow-hidden ${
        isCenter ? "border-blue-500" : "border-slate-200"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-slate-400" />

      {thumbnailUrl && (
        <div className="h-16 bg-slate-50 overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumbnailUrl}
            alt=""
            className="w-full h-full object-cover"
          />
        </div>
      )}

      <div className="px-2 py-1.5">
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-600 mb-1">
          {ASSET_KIND_LABELS[kind] ?? kind}
        </span>
        <p className="text-xs text-slate-800 font-medium leading-tight line-clamp-2">
          {title || "(無題)"}
        </p>
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-slate-400" />
    </div>
  );
}
