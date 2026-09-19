"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Download } from "lucide-react";
import type { ImportCandidate } from "@/lib/domain/meetgreet-import";
import { MEETGREET_FORMAT_LABELS } from "@/lib/utils";
import { importMeetGreetsAction } from "../actions";

/** 取り込む候補のチェックリスト。既定では全部チェック (人は外すだけで済む) */
export function ImportForm({ candidates }: { candidates: ImportCandidate[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ dossierTitle: string; error: string }[]>([]);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(candidates.map((c) => c.dossierId))
  );

  function toggle(id: string) {
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function importSelected() {
    if (picked.size === 0) {
      setMsg("チェックされたドシエがありません");
      return;
    }
    setMsg(`${picked.size} 件を取り込んでいます…`);
    setFailed([]);
    startTransition(async () => {
      const res = await importMeetGreetsAction([...picked]).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "通信に失敗しました",
      }));
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setFailed(res.failed);
      setMsg(
        res.failed.length === 0
          ? `${res.imported} 件を取り込みました`
          : `${res.imported} 件を取り込み、${res.failed.length} 件は失敗しました`
      );
      router.refresh();
    });
  }

  if (candidates.length === 0) {
    return (
      <div className="bg-white border border-dashed border-slate-300 rounded-lg p-10 text-center text-sm text-slate-500">
        取り込めるドシエはありません。
        <br />
        <span className="text-xs">
          対象は「2026-08-01 京都リアミ」のように <code>日付 + 呼び分け + オンミ/リアミ</code> の名前が付いた、
          まだミーグリになっていないドシエです。
        </span>
      </div>
    );
  }

  const allOn = picked.size === candidates.length;

  return (
    <div>
      <div className="bg-white border border-slate-200 rounded-lg">
        <div className="flex items-center gap-3 px-4 py-2 bg-slate-50 border-b border-slate-200">
          <input
            type="checkbox"
            checked={allOn}
            ref={(el) => {
              if (el) el.indeterminate = picked.size > 0 && !allOn;
            }}
            onChange={() =>
              setPicked(allOn ? new Set() : new Set(candidates.map((c) => c.dossierId)))
            }
            aria-label="すべてチェック"
          />
          <span className="text-xs text-slate-600">
            {candidates.length} 件の候補（{picked.size} 件を選択中）
          </span>
        </div>
        <ul className="divide-y divide-slate-100">
          {candidates.map((c) => (
            <li key={c.dossierId}>
              <label className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={picked.has(c.dossierId)}
                  onChange={() => toggle(c.dossierId)}
                  aria-label={c.dossierTitle}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-slate-900 truncate">
                    {c.date} {c.label}
                    {MEETGREET_FORMAT_LABELS[c.format]}ミーグリ
                  </span>
                  <span className="block text-xs text-slate-500 truncate mt-0.5">
                    {c.single || <span className="text-amber-700">シングル名が拾えませんでした</span>}
                    {" · "}
                    {c.dossierTitle}
                  </span>
                </span>
                <span className="flex items-center gap-1.5 shrink-0 text-[11px]">
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-600 tabular-nums">
                    素材 {c.itemCount}
                  </span>
                  {c.collection ? (
                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-emerald-700 tabular-nums">
                      レポ {c.collection.keepCount}/{c.collection.tweetCount}
                    </span>
                  ) : (
                    <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-slate-400">
                      収集なし
                    </span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={importSelected}
          disabled={pending || picked.size === 0}
          className="inline-flex items-center gap-1 h-9 px-4 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800 disabled:opacity-50"
        >
          <Download size={14} /> 取り込む ({picked.size})
        </button>
        {msg && <span className="text-xs text-slate-500">{msg}</span>}
      </div>

      {failed.length > 0 && (
        <ul className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 space-y-1">
          {failed.map((f) => (
            <li key={f.dossierTitle} className="text-xs text-amber-800">
              {f.dossierTitle}: {f.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
