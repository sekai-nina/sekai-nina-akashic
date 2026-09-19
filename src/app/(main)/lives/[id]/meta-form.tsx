"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { MAX_LIVE_NAME } from "@/lib/live/api";
import { deleteLiveAction, updateLiveAction } from "../actions";

const inputCls =
  "px-2 py-1 rounded-md border border-slate-200 bg-white text-sm text-slate-900 outline-none focus:border-slate-400";

/** ライブ名・補足の編集と、行の削除 (ドシエ / 収集 / エンティティは残る) */
export function MetaForm({
  id,
  name,
  note,
  entity,
}: {
  id: string;
  name: string;
  note: string;
  entity: { id: string; canonicalName: string } | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [n, setN] = useState(name);
  const [t, setT] = useState(note);
  const [msg, setMsg] = useState<string | null>(null);

  if (!editing) {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
        {entity ? (
          <Link href={`/entities/${entity.id}`} className="text-slate-500 hover:underline">
            イベント: {entity.canonicalName}
          </Link>
        ) : (
          <span className="text-slate-400">イベントエンティティ未設定</span>
        )}
        {note && <span className="text-slate-500 whitespace-pre-wrap">· {note}</span>}
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
      const res = await updateLiveAction(id, { name: n, note: t });
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  function remove() {
    if (!confirm("このライブを削除します。ドシエ・X レポ収集・イベントエンティティは残ります。よろしいですか？")) return;
    startTransition(async () => {
      const res = await deleteLiveAction(id);
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      router.push("/lives");
    });
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
      <input
        className={inputCls + " w-full sm:w-96"}
        value={n}
        onChange={(e) => setN(e.target.value)}
        placeholder="ライブ名"
        aria-label="ライブ名"
        maxLength={MAX_LIVE_NAME}
      />
      <textarea
        className={inputCls + " w-full min-h-[3rem]"}
        value={t}
        onChange={(e) => setT(e.target.value)}
        placeholder="補足 (記事の公演の章に出ます)"
        aria-label="補足"
      />
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
        作成済みのドシエ・X レポ収集・イベントエンティティの名前は変わりません (それぞれの画面で変更してください)。
      </p>
      {msg && <span className="text-xs text-red-600 w-full">{msg}</span>}
    </div>
  );
}
