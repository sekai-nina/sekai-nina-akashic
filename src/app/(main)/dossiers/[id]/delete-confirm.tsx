"use client";

import { Loader2 } from "lucide-react";

/**
 * 削除の確認をページ内に出す。
 * スマホで企画の削除が「押しても反応しない」と報告があり、サーバーには削除が一度も届いていなかった。
 * ブラウザの confirm() に頼らず、確認もページの中で済ませる
 */
export function DeleteConfirm({
  message,
  onConfirm,
  onCancel,
  pending,
  className,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alertdialog"
      className={`rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 ${className ?? ""}`}
    >
      <p>{message}</p>
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-600 hover:bg-slate-50 disabled:opacity-50 sm:py-1"
        >
          やめる
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-3 py-2 font-medium text-white hover:bg-rose-700 disabled:opacity-50 sm:py-1"
        >
          {pending && <Loader2 className="h-3 w-3 animate-spin" />}
          削除する
        </button>
      </div>
    </div>
  );
}
