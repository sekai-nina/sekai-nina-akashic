"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { SongParticipation } from "@prisma/client";
import { SONG_PARTICIPATION_LABELS } from "@/lib/utils";
import { updateSongAction } from "../actions";

const inputCls =
  "w-full px-2 py-1 rounded-md border border-slate-200 bg-white text-sm text-slate-900 outline-none focus:border-slate-400";
const labelCls = "block text-[11px] text-slate-500 mb-0.5";

export function SongEditForm({
  id,
  title,
  participation,
  note,
}: {
  id: string;
  title: string;
  participation: SongParticipation;
  note: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [t, setT] = useState(title);
  const [p, setP] = useState<SongParticipation>(participation);
  const [n, setN] = useState(note);
  const [msg, setMsg] = useState<string | null>(null);

  function save() {
    setMsg("保存中…");
    startTransition(async () => {
      const res = await updateSongAction(id, { title: t, participation: p, note: n });
      setMsg(res.ok ? "保存しました" : `エラー: ${res.error}`);
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <label className={labelCls} htmlFor="song-title">
          曲名 (公式表記。収録のある曲は表記の揺れ以外に変えられない。誤字の曲は統合で片付ける)
        </label>
        <input id="song-title" className={inputCls} value={t} onChange={(e) => setT(e.target.value)} />
      </div>
      <div>
        <span className={labelCls}>坂井新奈の参加楽曲か</span>
        <div className="flex gap-2">
          {(Object.keys(SONG_PARTICIPATION_LABELS) as SongParticipation[]).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={p === k}
              onClick={() => setP(k)}
              className={
                "px-3 py-1 rounded-md border text-xs " +
                (p === k ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50")
              }
            >
              {SONG_PARTICIPATION_LABELS[k]}
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className={labelCls} htmlFor="song-note">メモ (ライブ限定アレンジの由来など)</label>
        <textarea id="song-note" className={inputCls + " min-h-[3rem]"} value={n} onChange={(e) => setN(e.target.value)} />
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="h-8 px-3 rounded-md bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50"
        >
          保存
        </button>
        {msg && (
          <span role="status" className="text-xs text-slate-500">
            {msg}
          </span>
        )}
      </div>
    </div>
  );
}
