"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateLiveAction } from "../actions";

const inputCls =
  "w-full px-2 py-1 rounded-md border border-slate-200 bg-white text-sm text-slate-900 outline-none focus:border-slate-400";

/**
 * X レポ収集のハッシュタグ (#150)。「坂井新奈 AND 各タグ」をタグごとに作り、タグ間は OR。
 * 空なら #坂井新奈 だけで集める (ライブ当日は本人の名前だけの投稿が多いので、それでも拾える)
 */
export function ReportTagsForm({ liveId, tags }: { liveId: string; tags: string[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState(tags.map((t) => `#${t}`).join(" "));
  const [msg, setMsg] = useState<string | null>(null);

  function save() {
    const next = text
      .split(/[\s,、]+/)
      .map((t) => t.trim().replace(/^#/, ""))
      .filter(Boolean);
    setMsg("保存中…");
    startTransition(async () => {
      const res = await updateLiveAction(liveId, { reportTags: next });
      setMsg(res.ok ? "保存しました (収集の条件も更新)" : `エラー: ${res.error}`);
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="mb-3">
      <label className="block text-[11px] text-slate-500 mb-0.5" htmlFor="live-report-tags">
        ハッシュタグ (空白区切り。坂井新奈 AND 各タグ、タグ間は OR。空なら #坂井新奈 だけ)
      </label>
      <div className="flex gap-2">
        <input
          id="live-report-tags"
          className={inputCls}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="#MONSTER_GROOVE #日向坂46宮城"
          disabled={pending}
        />
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="h-8 px-3 rounded-md border border-slate-200 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50 shrink-0"
        >
          保存
        </button>
      </div>
      {msg && (
        <p role="status" className="text-[11px] text-slate-500 mt-1">
          {msg}
        </p>
      )}
    </div>
  );
}
