"use client";

import { useState, useTransition, useRef, useEffect } from "react";
import { Plus, Check, Loader2, FolderSearch } from "lucide-react";
import { addAssetToDossierAction, createDossierWithAssetAction } from "@/app/(main)/dossiers/actions";

interface EditableDossier {
  id: string;
  title: string;
}

interface AddToDossierProps {
  assetId: string;
  dossiers: EditableDossier[];
  /** Item caption to record on creation (usually asset.title). */
  defaultCaption?: string;
  /** Optional excerpt payload — used by the in-source range-selection flow. */
  excerpt?: {
    text: string;
    textType?: string;
    textStart?: number;
    textEnd?: number;
  };
  /** "icon" renders a compact + button; "button" renders a labelled button. */
  variant?: "icon" | "button";
  /** Optional ids of dossiers that already contain this asset (rendered greyed out). */
  alreadyAdded?: string[];
  /** Visual size of the trigger. */
  size?: "sm" | "md";
  /** Called after an asset is successfully added to an existing dossier. */
  onAdded?: (dossierId: string, dossierTitle: string) => void;
}

export function AddToDossier({
  assetId,
  dossiers,
  defaultCaption,
  excerpt,
  variant = "icon",
  alreadyAdded = [],
  size = "sm",
  onAdded,
}: AddToDossierProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set(alreadyAdded));
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [isPending, startTransition] = useTransition();
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleDown(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleDown);
    return () => document.removeEventListener("mousedown", handleDown);
  }, [open]);

  function addToExisting(dossierId: string) {
    if (addedIds.has(dossierId)) return;
    const target = dossiers.find((d) => d.id === dossierId);
    setPendingId(dossierId);
    startTransition(async () => {
      try {
        await addAssetToDossierAction(dossierId, assetId, {
          caption: defaultCaption,
          excerpt: excerpt?.text,
          excerptType: excerpt?.textType as never,
          excerptStart: excerpt?.textStart,
          excerptEnd: excerpt?.textEnd,
        });
        setAddedIds((prev) => new Set(prev).add(dossierId));
        if (onAdded) {
          onAdded(dossierId, target?.title || "(無題)");
          setOpen(false);
        }
      } finally {
        setPendingId(null);
      }
    });
  }

  function createAndAdd() {
    if (!newTitle.trim()) return;
    startTransition(async () => {
      const result = await createDossierWithAssetAction(newTitle.trim(), assetId, {
        caption: defaultCaption,
        excerpt: excerpt?.text,
        excerptType: excerpt?.textType as never,
        excerptStart: excerpt?.textStart,
        excerptEnd: excerpt?.textEnd,
      });
      setAddedIds((prev) => new Set(prev).add(result.dossierId));
      setNewTitle("");
      setCreating(false);
      if (onAdded) {
        onAdded(result.dossierId, result.title);
        setOpen(false);
      }
    });
  }

  const filtered = query
    ? dossiers.filter((d) => d.title.toLowerCase().includes(query.toLowerCase()))
    : dossiers;

  const trigger =
    variant === "button" ? (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs border border-slate-300 hover:bg-slate-50"
      >
        <FolderSearch className="h-3.5 w-3.5" /> ドシエに追加
      </button>
    ) : (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="ドシエに追加"
        className={`inline-flex items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 hover:text-indigo-600 hover:border-indigo-300 shadow-sm ${
          size === "md" ? "w-7 h-7" : "w-6 h-6"
        }`}
      >
        <Plus className={size === "md" ? "h-4 w-4" : "h-3.5 w-3.5"} />
      </button>
    );

  return (
    <div ref={popoverRef} className="relative inline-block">
      {trigger}
      {open && (
        <div className="absolute right-0 mt-1 z-50 w-64 bg-white text-slate-700 border border-slate-200 rounded-lg shadow-lg p-2">
          {!creating ? (
            <>
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ドシエを検索..."
                className="w-full text-xs border border-slate-300 rounded px-2 py-1 mb-2 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <ul className="max-h-56 overflow-y-auto space-y-0.5">
                {filtered.length === 0 && (
                  <li className="text-[11px] text-slate-400 px-2 py-1.5">該当なし</li>
                )}
                {filtered.map((d) => {
                  const added = addedIds.has(d.id);
                  return (
                    <li key={d.id}>
                      <button
                        type="button"
                        onClick={() => addToExisting(d.id)}
                        disabled={added || isPending}
                        className={`w-full text-left flex items-center justify-between gap-2 px-2 py-1.5 rounded text-xs ${
                          added
                            ? "text-slate-400 cursor-default"
                            : "text-slate-700 hover:bg-indigo-50"
                        }`}
                      >
                        <span className="truncate">{d.title || "(無題)"}</span>
                        {added ? (
                          <Check className="h-3 w-3 text-emerald-500 shrink-0" />
                        ) : pendingId === d.id ? (
                          <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-2 border-t border-slate-100 pt-2">
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="w-full text-xs text-indigo-600 hover:underline flex items-center gap-1 px-2 py-1"
                >
                  <Plus className="h-3 w-3" /> 新規ドシエを作成
                </button>
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-slate-600">新規ドシエ</p>
              <input
                autoFocus
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="タイトル"
                className="w-full text-xs border border-slate-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <p className="text-[10px] text-slate-400">
                作成と同時に、このアセットを新しいドシエに追加します。
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCreating(false)}
                  className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1"
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  onClick={createAndAdd}
                  disabled={!newTitle.trim() || isPending}
                  className="bg-indigo-600 text-white px-2 py-1 rounded text-xs font-medium hover:bg-indigo-700 disabled:opacity-50 inline-flex items-center gap-1"
                >
                  {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                  作成して追加
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
