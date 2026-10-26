"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { transcribeAsset } from "./transcribe-actions";

/**
 * 音声・動画の文字起こし (#282)。坂井新奈のトークは cron が自動で回すので、
 * ここはそれ以外を 1 件ずつ回すのと、やり直しのための入口。
 */
export function TranscribePanel({
  assetId,
  transcribedAt,
  transcribeError,
  hasTranscript,
  blockedReason,
}: {
  assetId: string;
  transcribedAt: Date | null;
  transcribeError: string | null;
  hasTranscript: boolean;
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
        const res = await transcribeAsset(assetId);
        if (res.error) setError(res.error);
        else if (res.empty) {
          setMessage(hasTranscript ? "喋っている部分が見つかりませんでした。いまの本文はそのままです" : "喋っている部分が見つかりませんでした");
        } else setMessage("保存しました。前の本文があれば版として残っています");
      } catch {
        setError("文字起こしに失敗しました。時間をおいてもう一度試してください");
      }
    });
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="text-sm font-semibold text-slate-700 mb-2">文字起こし</h2>
      <p className="text-xs text-slate-500 mb-3">
        {transcribedAt
          ? transcribeError
            ? `できませんでした（${formatDate(transcribedAt, true)}）: ${transcribeError}`
            : hasTranscript
              ? `済み（${formatDate(transcribedAt, true)}）。本文は「文字起こし」に入っています`
              : `喋っている部分がありませんでした（${formatDate(transcribedAt, true)}）`
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
          {pending ? "文字起こし中…" : transcribedAt ? "やり直す" : "文字起こしする"}
        </button>
      )}
      {message && <p className="text-xs text-slate-500 mt-2">{message}</p>}
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  );
}
