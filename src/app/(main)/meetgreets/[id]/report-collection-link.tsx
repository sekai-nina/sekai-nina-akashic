"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Link2 } from "lucide-react";
import type { LinkableCollection } from "@/lib/domain/meetgreet-import";
import { linkReportCollectionAction } from "../actions";

/**
 * `/repo` で先に集めていた収集をこの回に結びつける。
 * 取得が無い回に同じ日の収集があるときは、最初から開いて気づけるようにする
 */
export function ReportCollectionLink({
  id,
  date,
  hasReports,
  candidates,
}: {
  id: string;
  date: string;
  hasReports: boolean;
  candidates: LinkableCollection[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [picked, setPicked] = useState(() =>
    candidates[0]?.startDate === date ? candidates[0].id : ""
  );
  const [msg, setMsg] = useState<string | null>(null);

  if (candidates.length === 0) return null;

  function link() {
    if (!picked) return;
    setMsg("結びつけています…");
    startTransition(async () => {
      const res = await linkReportCollectionAction(id, picked).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "通信に失敗しました",
      }));
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setMsg(res.removedEmpty ? "結びつけました (空の収集は消しました)" : "結びつけました");
      setPicked("");
      router.refresh();
    });
  }

  return (
    <details
      className="mb-3 rounded-md border border-slate-200 px-3 py-2"
      open={!hasReports && candidates[0].startDate === date}
    >
      <summary className="text-xs font-medium text-slate-700 cursor-pointer">
        既存のレポ収集を結びつける
      </summary>
      <p className="text-[11px] text-slate-500 mt-2">
        今の収集は、取得 0 件なら消し、ツイートが入っていれば /repo に残します。
      </p>
      <div className="flex gap-2 mt-2">
        <select
          aria-label="結びつける収集"
          className="min-w-0 flex-1 h-8 px-2 rounded-md border border-slate-200 bg-white text-xs text-slate-900"
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
          disabled={pending}
        >
          <option value="">収集を選ぶ</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.startDate ?? "日付なし"} {c.name} (採用 {c.keepCount} / 取得 {c.tweetCount})
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={link}
          disabled={pending || !picked}
          className="inline-flex items-center gap-1 h-8 px-3 rounded-md border border-slate-200 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50 shrink-0"
        >
          <Link2 size={12} />
          結びつける
        </button>
      </div>
      {msg && (
        <p role="status" className="text-[11px] text-slate-500 mt-1">
          {msg}
        </p>
      )}
    </details>
  );
}
