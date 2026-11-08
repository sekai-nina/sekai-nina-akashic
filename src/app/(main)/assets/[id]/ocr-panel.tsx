"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { ocrAsset } from "./ocr-actions";

/**
 * 画像の OCR (#379)。1 件ずつ回すのと、やり直しのための入口。
 * まとめて回すときは親の子アセット一覧の子アセット一覧の「選択して OCR」(cron が順に回す)
 */
export function OcrPanel({
  assetId,
  ocrAt,
  ocrError,
  ocrRequestedAt,
  hasOcr,
  blockedReason,
}: {
  assetId: string;
  ocrAt: Date | null;
  ocrError: string | null;
  ocrRequestedAt: Date | null;
  hasOcr: boolean;
  /** 押せない理由 (機密など)。あればボタンを出さない */
  blockedReason: string | null;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleClick() {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await ocrAsset(assetId);
        if (res.error) setError(res.error);
        else if (res.empty) {
          setMessage(hasOcr ? "文字が見つかりませんでした。いまの本文はそのままです" : "文字が見つかりませんでした");
        } else setMessage("保存しました。前の本文があれば版として残っています");
      } catch {
        setError("OCR に失敗しました。時間をおいてもう一度試してください");
      }
    });
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="text-sm font-semibold text-slate-700 mb-2">OCR</h2>
      <p className="text-xs text-slate-500 mb-3">
        {ocrAt
          ? ocrError
            ? `できませんでした（${formatDate(ocrAt, true)}）: ${ocrError}`
            : hasOcr
              ? `済み（${formatDate(ocrAt, true)}）。本文は「OCR」に入っています`
              : `文字がありませんでした（${formatDate(ocrAt, true)}）`
          : hasOcr
            ? "本文は「OCR」に入っています"
            : ocrRequestedAt
              ? "待ち（15 分ごとに順に処理します）"
              : "まだです"}
      </p>
      {blockedReason ? (
        <p className="text-xs text-slate-400">{blockedReason}</p>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={handleClick}
          className="inline-flex items-center gap-1.5 border border-slate-300 px-3 py-1.5 rounded text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          {pending && <Loader2 size={14} className="animate-spin" />}
          {pending ? "読み取り中…" : ocrAt || hasOcr ? "やり直す" : "OCR する"}
        </button>
      )}
      {message && <p className="text-xs text-slate-500 mt-2">{message}</p>}
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  );
}
