"use client";

import { useState, useTransition } from "react";
import { ScanText } from "lucide-react";
import { requestChildrenOcrAction } from "./ocr-actions";

/**
 * 子アセット一覧の「まとめて OCR」(#379)。子の画像を OCR 待ちにする。
 * 実際に回すのは 15 分ごとの cron なので、押したらすぐには本文は入らない
 */
export function ChildOcrButton({ parentId }: { parentId: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleClick() {
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await requestChildrenOcrAction(parentId);
        if (res.error) setMessage(res.error);
        else if (!res.count) setMessage("OCR 待ちにできる画像はありませんでした (済み・待ち・機密を除く)");
        else setMessage(`${res.count} 件を OCR 待ちにしました。15 分ごとに順に処理します`);
      } catch {
        setMessage("失敗しました。時間をおいてもう一度試してください");
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2 text-xs text-slate-500">
      <button
        type="button"
        disabled={pending}
        onClick={handleClick}
        className="inline-flex items-center gap-1 border border-slate-300 rounded px-2 py-1 text-slate-700 hover:bg-slate-50 disabled:opacity-60"
      >
        <ScanText size={12} aria-hidden />
        {pending ? "登録中…" : "まとめて OCR"}
      </button>
      {message && <span className="text-slate-600">{message}</span>}
    </div>
  );
}
