"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScanText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OcrState } from "@/lib/domain/ocr";
import { requestChildrenOcrAction } from "./ocr-actions";

const STATE_LABELS: Record<Exclude<OcrState, "none">, string> = {
  done: "OCR済",
  queued: "OCR待ち",
  failed: "OCR失敗",
};

const STATE_COLORS: Record<Exclude<OcrState, "none">, string> = {
  done: "bg-emerald-600 text-white",
  queued: "bg-amber-500 text-white",
  failed: "bg-red-600 text-white",
};

/** サムネイルの左下に出す OCR の状態。まだのものには出さない */
export function OcrStateBadge({ state }: { state: OcrState | undefined }) {
  if (!state || state === "none") return null;
  return (
    <span className={cn("absolute bottom-1 left-1 px-1.5 py-0.5 rounded text-[10px] font-medium pointer-events-none", STATE_COLORS[state])}>
      {STATE_LABELS[state]}
    </span>
  );
}

/** サムネイルの左上のチェックボックス。まだ OCR していない画像だけ選べる */
export function OcrSelectCheckbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className="absolute top-1 left-1 p-1 bg-white/90 rounded shadow-sm cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={`${label} を OCR に選ぶ`}
        className="block w-4 h-4 accent-blue-600 cursor-pointer"
      />
    </label>
  );
}

/**
 * 子アセット一覧で選んだ画像の OCR (#379)。選んだものだけを OCR 待ちにし、15 分ごとの cron が順に処理する。
 * 選べるのはまだ OCR していない画像だけ (済み・待ち・失敗はアセット詳細の「OCR」パネルからやり直す)
 */
export function ChildOcrToolbar({
  parentId,
  selected,
  selectableIds,
  onSelectAll,
  onClear,
}: {
  parentId: string;
  selected: Set<string>;
  selectableIds: string[];
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setMessage(null);
    const ids = [...selected];
    startTransition(async () => {
      try {
        const res = await requestChildrenOcrAction(parentId, ids);
        if (res.error) setMessage(res.error);
        else {
          setMessage(
            res.count
              ? `${res.count} 件を OCR 待ちにしました。15 分ごとに順に処理します`
              : "OCR 待ちにできる画像はありませんでした (済み・待ち・機密を除く)",
          );
          onClear();
          router.refresh();
        }
      } catch {
        setMessage("失敗しました。時間をおいてもう一度試してください");
      }
    });
  }

  if (selectableIds.length === 0 && !message) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2 text-xs text-slate-500">
      <span>OCR:</span>
      {selectableIds.length > 0 && (
        <>
          <button type="button" onClick={onSelectAll} className="text-blue-600 hover:underline">
            まだのものをすべて選択 ({selectableIds.length})
          </button>
          {selected.size > 0 && (
            <button type="button" onClick={onClear} className="text-slate-600 hover:underline">
              選択を解除
            </button>
          )}
          <button
            type="button"
            disabled={pending || selected.size === 0}
            onClick={submit}
            className="ml-auto inline-flex items-center gap-1 border border-slate-300 rounded px-2 py-1 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <ScanText size={12} aria-hidden />
            {pending ? "登録中…" : `選択した ${selected.size} 件を OCR`}
          </button>
        </>
      )}
      {message && <span className="w-full text-slate-600">{message}</span>}
    </div>
  );
}
