"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { setExcludedUsernamesAction, type MentionActionState } from "./actions";

/**
 * 除外ユーザーの編集。@ 抜きのユーザー名を改行かカンマで並べる。
 * 保存時に丸ごと置き換える (形の違うものが混ざっていれば保存せず指摘する)。
 */
export function ExclusionForm({ usernames, canEdit }: { usernames: string[]; canEdit: boolean }) {
  const [draft, setDraft] = useState(usernames.join("\n"));
  const [saved, setSaved] = useState(usernames);
  const [state, setState] = useState<MentionActionState | null>(null);
  const [isPending, startTransition] = useTransition();
  const dirty = draft.trim() !== saved.join("\n");

  function save() {
    if (isPending || !dirty) return;
    startTransition(async () => {
      const r = await setExcludedUsernamesAction(draft);
      // 保存できたら入力も保存後の形 (小文字・@ 抜き・重複なし) に揃える
      if (r.ok && "usernames" in r) {
        setSaved(r.usernames);
        setDraft(r.usernames.join("\n"));
      }
      setState(r);
    });
  }

  if (!canEdit) {
    return usernames.length === 0 ? (
      <p className="text-slate-400 text-sm">除外ユーザーはありません</p>
    ) : (
      <div className="flex flex-wrap gap-1.5">
        {usernames.map((u) => (
          <span key={u} className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-mono">
            @{u}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={Math.min(Math.max(saved.length + 1, 3), 12)}
        placeholder={"hinatazaka46\nsakai_nina_official"}
        aria-label="除外ユーザー"
        className={cn(
          "w-full px-3 py-2 rounded-md border bg-white text-sm text-slate-900 outline-none focus:border-slate-400 font-mono",
          dirty ? "border-amber-400" : "border-slate-200"
        )}
        spellCheck={false}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={isPending || !dirty}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
        >
          {isPending && <Loader2 size={14} className="animate-spin" />}
          保存
        </button>
        <span className="text-xs text-slate-400">@ 抜きのユーザー名を改行かカンマで区切る。この人たちの投稿は拾わない</span>
        {state && (
          <span className={`text-xs ${state.ok ? "text-emerald-700" : "text-red-700"}`}>
            {state.ok ? state.message : state.error}
          </span>
        )}
      </div>
    </div>
  );
}
