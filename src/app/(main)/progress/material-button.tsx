"use client";

import { createContext, useContext, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { MATERIAL_PROGRESS_LABELS as L, cn } from "@/lib/utils";
import { setMaterialClipProgressAction } from "./material-actions";

const MaterialControlsContext = createContext<{ readOnly: boolean; disable: () => void } | null>(null);

/** 同じ素材の済・手動対象ボタンを、権限エラー後はまとめて操作不可にする。 */
export function MaterialProgressControls({ children }: { children: ReactNode }) {
  const [readOnly, setReadOnly] = useState(false);
  return <MaterialControlsContext.Provider value={{ readOnly, disable: () => setReadOnly(true) }}>
    <div className="flex flex-wrap gap-2">{children}</div>
  </MaterialControlsContext.Provider>;
}

export function MaterialProgressButton({ sourceKey, itemKey, field = "done", value, label, editable = true }: {
  sourceKey: string; itemKey: string; field?: "done" | "included"; value: boolean; label?: string; editable?: boolean;
}) {
  const controls = useContext(MaterialControlsContext);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const router = useRouter();
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button type="button" disabled={pending || !editable || readOnly || controls?.readOnly} aria-pressed={field === "done" ? !value : undefined}
        className={cn("rounded border px-3 py-1.5 text-xs disabled:opacity-50", field === "done" && !value
          ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-white text-slate-700")}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            try {
              const result = await setMaterialClipProgressAction(sourceKey, itemKey, field, value);
              if (!result.ok) {
                setError(result.error);
                if (result.readOnly) {
                  setReadOnly(true);
                  controls?.disable();
                }
              }
              else router.refresh();
            } catch { setError(L.failed); }
          });
        }}>
        {pending ? L.saving : label ?? (value ? L.markDone : `✓ ${L.done}`)}
      </button>
      {error && <span role="alert" className="text-xs text-red-700">{error}</span>}
    </span>
  );
}
