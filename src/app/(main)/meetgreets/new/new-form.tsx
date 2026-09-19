"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { MeetGreetFormat } from "@prisma/client";
import type { LinkableDossier } from "@/lib/domain/meetgreet-import";
import { MEETGREET_FORMAT_LABELS } from "@/lib/utils";
import { createMeetGreetAction } from "../actions";

const inputCls =
  "w-full px-3 py-2 rounded-md border border-slate-200 bg-white text-sm text-slate-900 outline-none focus:border-slate-400";
const labelCls = "block text-xs text-slate-500 mt-3 mb-1";

export function NewMeetGreetForm({
  defaultDate,
  dossiers,
}: {
  defaultDate: string;
  dossiers: LinkableDossier[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const [date, setDate] = useState(defaultDate);
  const [format, setFormat] = useState<MeetGreetFormat>("online");
  const [single, setSingle] = useState("");
  const [label, setLabel] = useState("");
  // 空文字 = 新しく作る
  const [dossierId, setDossierId] = useState("");

  function handleCreate() {
    if (!date) {
      setMsg("日付を入力してください");
      return;
    }
    setMsg("作成中…");
    startTransition(async () => {
      const res = await createMeetGreetAction({
        date,
        format,
        single,
        label,
        ...(dossierId ? { dossierId } : {}),
      });
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      // 遷移すると setMsg は読めないので、開いた先で知らせる
      router.push(`/meetgreets/${res.id}${res.reused ? "?reused=1" : ""}`);
    });
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5">
      <label className={labelCls} htmlFor="mg-date">開催日</label>
      <input
        id="mg-date"
        type="date"
        className={inputCls}
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />

      <span className={labelCls}>形式</span>
      <div className="flex gap-2">
        {(Object.keys(MEETGREET_FORMAT_LABELS) as MeetGreetFormat[]).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={format === f}
            onClick={() => setFormat(f)}
            className={
              "px-3 py-1.5 rounded-md border text-sm " +
              (format === f
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50")
            }
          >
            {MEETGREET_FORMAT_LABELS[f]}
          </button>
        ))}
      </div>

      <label className={labelCls} htmlFor="mg-single">
        シングル (記事の meetgreet.single に出ます。例: 17thシングル「Kind of love」)
      </label>
      <input
        id="mg-single"
        className={inputCls}
        value={single}
        onChange={(e) => setSingle(e.target.value)}
        placeholder="17thシングル「Kind of love」"
      />

      <label className={labelCls} htmlFor="mg-label">
        呼び分け (任意。作成時のドシエ名・収集名に付くだけ。例: 通常 / 初回限定盤 / 京都)
      </label>
      <input
        id="mg-label"
        className={inputCls}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="通常"
      />

      <label className={labelCls} htmlFor="mg-dossier">
        素材のドシエ
      </label>
      <select
        id="mg-dossier"
        className={inputCls}
        value={dossierId}
        onChange={(e) => setDossierId(e.target.value)}
      >
        <option value="">新しく作る</option>
        {dossiers.map((d) => (
          <option key={d.id} value={d.id}>
            {d.title}（素材 {d.itemCount} 件）
          </option>
        ))}
      </select>
      {dossierId && (
        <p className="text-[11px] text-slate-400 mt-1">
          既存のドシエを使います。ドシエ名は変わりません。X レポ収集は新しく作られます
          （まとめて取り込むなら「過去のドシエを取り込む」のほうが早いです）。
        </p>
      )}

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={handleCreate}
          disabled={pending}
          className="h-9 px-4 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800 disabled:opacity-50"
        >
          作成する
        </button>
        {msg && <span className="text-xs text-slate-500">{msg}</span>}
      </div>
    </div>
  );
}
