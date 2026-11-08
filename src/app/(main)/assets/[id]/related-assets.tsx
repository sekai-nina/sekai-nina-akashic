"use client";

import { useState } from "react";
import Link from "next/link";
import { removeAssetRelation } from "@/lib/actions";
import { ASSET_KIND_LABELS, RELATION_TYPE_LABELS } from "@/lib/utils";
import { X } from "lucide-react";
import type { NinaAppearance } from "@/lib/nina";
import type { OcrState } from "@/lib/domain/ocr";
import { ChildOcrToolbar, OcrSelectCheckbox, OcrStateBadge } from "./child-ocr-selection";
import { ChildNinaSummary, ChildNinaToggle, ninaFrameClass, type ChildNinaState } from "./child-nina-toggle";

interface RelatedAsset {
  id: string;
  title: string;
  kind: string;
  thumbnailUrl: string | null;
}

interface Relation {
  id: string;
  relationType: string;
  sortOrder: number;
  asset: RelatedAsset;
}

function RelationTypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    parent_child: "bg-blue-100 text-blue-800",
    derived_from: "bg-amber-100 text-amber-800",
    reference: "bg-emerald-100 text-emerald-800",
    same_content: "bg-violet-100 text-violet-800",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors[type] ?? "bg-slate-100 text-slate-600"}`}>
      {RELATION_TYPE_LABELS[type] ?? type}
    </span>
  );
}

function RemoveButton({ relationId, assetId }: { relationId: string; assetId: string }) {
  return (
    <button
      onClick={async () => {
        if (confirm("このリレーションを削除しますか？")) {
          await removeAssetRelation(relationId, assetId);
        }
      }}
      className="p-0.5 text-slate-400 hover:text-red-500 transition-colors"
      title="リレーション削除"
    >
      <X size={14} />
    </button>
  );
}

export function ParentAssets({
  relations,
  currentAssetId,
  embedded,
}: {
  relations: Relation[];
  currentAssetId: string;
  embedded?: boolean;
}) {
  if (relations.length === 0) return null;

  const content = (
    <ul className="space-y-2">
      {relations.map((rel) => (
        <li key={rel.id} className="flex items-center gap-3 text-sm">
          <RelationTypeBadge type={rel.relationType} />
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">
            {ASSET_KIND_LABELS[rel.asset.kind] ?? rel.asset.kind}
          </span>
          <Link
            href={`/assets/${rel.asset.id}`}
            className="text-blue-600 hover:text-blue-800 hover:underline font-medium truncate"
          >
            {rel.asset.title || "(無題)"}
          </Link>
          <RemoveButton relationId={rel.id} assetId={currentAssetId} />
        </li>
      ))}
    </ul>
  );

  if (embedded) return content;

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5">
      <h2 className="text-sm font-semibold text-slate-700 mb-3">親アセット</h2>
      {content}
    </div>
  );
}

export function ChildAssets({
  relations,
  currentAssetId,
  ninaStates = {},
  ocrStates = {},
  editable = false,
  embedded,
}: {
  relations: Relation[];
  currentAssetId: string;
  /** 子アセット (画像・動画) の坂井新奈の出演。一覧から付け外しする (#377) */
  ninaStates?: Record<string, ChildNinaState>;
  /** 子アセット (画像) の OCR の状態。まだのものを選んで OCR する (#379) */
  ocrStates?: Record<string, OcrState>;
  editable?: boolean;
  embedded?: boolean;
}) {
  const [ocrSelected, setOcrSelected] = useState<Set<string>>(new Set());
  if (relations.length === 0) return null;

  const imageRelations = relations.filter((r) => r.asset.kind === "image" || r.asset.kind === "video");
  const otherRelations = relations.filter((r) => r.asset.kind !== "image" && r.asset.kind !== "video");

  // 選べるのはまだ OCR していない画像だけ
  const ocrSelectableIds = imageRelations.filter((r) => ocrStates[r.asset.id] === "none").map((r) => r.asset.id);
  const toggleOcr = (assetId: string, on: boolean) =>
    setOcrSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(assetId);
      else next.delete(assetId);
      return next;
    });

  const counts: Record<NinaAppearance, number> = { appears: 0, absent: 0, unchecked: 0 };
  for (const rel of imageRelations) {
    const state = ninaStates[rel.asset.id];
    if (state) counts[state.appearance]++;
  }

  const content = (
    <>
      {imageRelations.length > 0 && (
        <ChildNinaSummary parentId={currentAssetId} counts={counts} editable={editable} />
      )}
      {editable && (
        <ChildOcrToolbar
          parentId={currentAssetId}
          selected={ocrSelected}
          selectableIds={ocrSelectableIds}
          onSelectAll={() => setOcrSelected(new Set(ocrSelectableIds))}
          onClear={() => setOcrSelected(new Set())}
        />
      )}
      {imageRelations.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2 mb-3">
          {imageRelations.map((rel) => (
            <div key={rel.id} className="relative group">
              {/* 画像の上に重ねるもの (選択・OCR の状態) はこの枠を基準にする。下の出演ボタンに被らないように */}
              <div className="relative">
                <Link href={`/assets/${rel.asset.id}`}>
                  {rel.asset.thumbnailUrl ? (
                    <img
                      src={rel.asset.thumbnailUrl}
                      alt={rel.asset.title || ""}
                      className={`w-full aspect-square object-cover rounded-lg border border-slate-200 hover:opacity-90 transition-opacity ${ninaFrameClass(ninaStates[rel.asset.id]?.appearance)}`}
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full aspect-square bg-slate-100 rounded-lg border border-slate-200 flex items-center justify-center text-xs text-slate-400">
                      {ASSET_KIND_LABELS[rel.asset.kind] ?? rel.asset.kind}
                    </div>
                  )}
                </Link>
                {editable && ocrStates[rel.asset.id] === "none" && (
                  <OcrSelectCheckbox
                    checked={ocrSelected.has(rel.asset.id)}
                    onChange={(on) => toggleOcr(rel.asset.id, on)}
                    label={rel.asset.title || "画像"}
                  />
                )}
                <OcrStateBadge state={ocrStates[rel.asset.id]} />
              </div>
              <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <RemoveButton relationId={rel.id} assetId={currentAssetId} />
              </div>
              {editable && ninaStates[rel.asset.id] && (
                <ChildNinaToggle assetId={rel.asset.id} state={ninaStates[rel.asset.id]} />
              )}
            </div>
          ))}
        </div>
      )}
      {otherRelations.length > 0 && (
        <ul className="space-y-2">
          {otherRelations.map((rel) => (
            <li key={rel.id} className="flex items-center gap-3 text-sm">
              <RelationTypeBadge type={rel.relationType} />
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">
                {ASSET_KIND_LABELS[rel.asset.kind] ?? rel.asset.kind}
              </span>
              <Link
                href={`/assets/${rel.asset.id}`}
                className="text-blue-600 hover:text-blue-800 hover:underline font-medium truncate"
              >
                {rel.asset.title || "(無題)"}
              </Link>
              <RemoveButton relationId={rel.id} assetId={currentAssetId} />
            </li>
          ))}
        </ul>
      )}
    </>
  );

  if (embedded) return content;

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5">
      <h2 className="text-sm font-semibold text-slate-700 mb-3">
        関連アセット ({relations.length})
      </h2>
      {content}
    </div>
  );
}
