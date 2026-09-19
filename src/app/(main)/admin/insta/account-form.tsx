"use client";

import { useState, useTransition } from "react";
import { Loader2, Save } from "lucide-react";
import { setInstaAccountAction, type InstaActionState } from "./actions";

/**
 * story を取りに行くときに使うアカウント。**パスワードはここでは扱わない。**
 * 認証情報は bot サーバの .env にだけ置き、初回ログインは人が
 * `insta-watch login --headful` で行う。
 */
export function AccountForm({
  initialUsername,
  initialNote,
}: {
  initialUsername: string;
  initialNote: string;
}) {
  const [username, setUsername] = useState(initialUsername);
  const [note, setNote] = useState(initialNote);
  const [state, setState] = useState<InstaActionState | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (isPending || !username.trim()) return;
    startTransition(async () => setState(await setInstaAccountAction({ username, note })));
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-500">ユーザー名</span>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username"
          className="border border-slate-300 rounded px-2 py-1.5 text-sm w-56 font-mono"
        />
      </label>
      <label className="flex flex-col gap-1 flex-1 min-w-40">
        <span className="text-xs text-slate-500">メモ（任意）</span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={200}
          className="border border-slate-300 rounded px-2 py-1.5 text-sm w-full"
        />
      </label>
      <button
        type="submit"
        disabled={isPending || !username.trim()}
        className="inline-flex itemsemphasis-center items-center gap-1.5 px-4 py-2 rounded bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
      >
        {isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
        保存
      </button>
      {state && (
        <p className={`w-full text-xs ${state.ok ? "text-emerald-700" : "text-red-700"}`}>
          {state.ok ? state.message : state.error}
        </p>
      )}
    </form>
  );
}
