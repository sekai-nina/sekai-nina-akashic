"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SONG_PARTICIPATION_LABELS } from "@/lib/utils";

const inputCls =
  "px-2 py-1 rounded-md border border-slate-200 bg-white text-sm text-slate-900 outline-none focus:border-slate-400";

/** 一覧の絞り込み。URL のクエリに載せる (共有できるように) */
export function SongFilter({ q, participation, orphan }: { q: string; participation: string; orphan: boolean }) {
  const router = useRouter();
  const [text, setText] = useState(q);

  function apply(next: { q?: string; participation?: string; orphan?: boolean }) {
    const params = new URLSearchParams();
    const nq = next.q ?? text;
    const np = next.participation ?? participation;
    const no = next.orphan ?? orphan;
    if (nq.trim()) params.set("q", nq.trim());
    if (np) params.set("participation", np);
    if (no) params.set("orphan", "1");
    const qs = params.toString();
    router.push(qs ? `/songs?${qs}` : "/songs");
  }

  return (
    <form
      className="mb-4 flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        apply({});
      }}
    >
      <input
        className={inputCls + " w-64"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="曲名 (表記揺れは無視)"
        aria-label="曲名で絞り込み"
      />
      <select
        className={inputCls}
        value={participation}
        onChange={(e) => apply({ participation: e.target.value })}
        aria-label="参加で絞り込み"
      >
        <option value="">参加: すべて</option>
        {(Object.keys(SONG_PARTICIPATION_LABELS) as (keyof typeof SONG_PARTICIPATION_LABELS)[]).map((k) => (
          <option key={k} value={k}>
            {SONG_PARTICIPATION_LABELS[k]}
          </option>
        ))}
      </select>
      <label className="inline-flex items-center gap-1 text-sm text-slate-600">
        <input type="checkbox" checked={orphan} onChange={(e) => apply({ orphan: e.target.checked })} />
        未収録だけ
      </label>
      <button
        type="submit"
        className="h-8 px-3 rounded-md bg-slate-900 text-white text-xs hover:bg-slate-800"
      >
        絞り込む
      </button>
    </form>
  );
}
