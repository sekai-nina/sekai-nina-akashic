"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { deleteMeetGreetAction, updateMeetGreetAction } from "../actions";

const inputCls =
  "px-2 py-1 rounded-md border border-slate-200 bg-white text-sm text-slate-900 outline-none focus:border-slate-400";

/** シングル名・呼び分けの編集と、行の削除 (ドシエ / 収集は残る) */
export function MetaForm({
  id,
  single,
  label,
  venue,
  isReal,
}: {
  id: string;
  single: string;
  label: string;
  venue: string | null;
  /** リアルミーグリのときだけ会場名を出す (記事タイトルに使うのはリアルだけ) */
  isReal: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [s, setS] = useState(single);
  const [l, setL] = useState(label);
  const [v, setV] = useState(venue ?? "");
  const [msg, setMsg] = useState<string | null>(null);

  if (!editing) {
    return (
      <div className="mt-1 flex items-center gap-2 text-sm text-slate-600">
        <span>
          {single || <span className="text-slate-400">シングル未設定</span>}
          {isReal && venue && <span className="text-slate-500"> · {venue}</span>}
        </span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-700"
        >
          <Pencil size={12} /> 編集
        </button>
      </div>
    );
  }

  function save() {
    startTransition(async () => {
      const res = await updateMeetGreetAction(id, { single: s, label: l, ...(isReal ? { venue: v } : {}) });
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  function remove() {
    if (!confirm("このミーグリを削除します。ドシエと X レポ収集は残ります。よろしいですか？")) return;
    startTransition(async () => {
      const res = await deleteMeetGreetAction(id);
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      router.push("/meetgreets");
    });
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
      <input
        className={inputCls + " w-72"}
        value={s}
        onChange={(e) => setS(e.target.value)}
        placeholder="シングル"
        aria-label="シングル"
      />
      <input
        className={inputCls + " w-32"}
        value={l}
        onChange={(e) => setL(e.target.value)}
        placeholder="呼び分け"
        aria-label="呼び分け"
      />
      {isReal && (
        <input
          className={inputCls + " w-40"}
          value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder="会場 (例: 幕張メッセ)"
          aria-label="会場の正式名称"
        />
      )}
      <button
        type="button"
        onClick={save}
        disabled={pending}
        className="h-8 px-3 rounded-md bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50"
      >
        保存
      </button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        className="h-8 px-3 rounded-md border border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
      >
        取消
      </button>
      <button
        type="button"
        onClick={remove}
        disabled={pending}
        className="h-8 px-3 rounded-md text-xs text-red-600 hover:bg-red-50 ml-auto"
      >
        削除
      </button>
      <p className="text-xs text-slate-400 w-full">
        作成済みのドシエ・X レポ収集の名前は変わりません (それぞれの画面で変更してください)。
        {isReal && " 会場は記事タイトルに出ます (未入力なら呼び分けを使います)。"}
      </p>
      {msg && <span className="text-xs text-red-600 w-full">{msg}</span>}
    </div>
  );
}
