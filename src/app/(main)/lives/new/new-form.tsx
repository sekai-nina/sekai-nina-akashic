"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { MAX_LIVE_NAME } from "@/lib/live/config";
import { createLiveAction } from "../actions";
import { newRow, SetlistEditor, toSetlistInput, type SetlistDraft } from "../setlist-editor";

const inputCls =
  "w-full px-3 py-2 rounded-md border border-slate-200 bg-white text-sm text-slate-900 outline-none focus:border-slate-400";
const labelCls = "block text-xs text-slate-500 mt-3 mb-1";

export interface EventOption {
  id: string;
  name: string;
  assetCount: number;
}

export function NewLiveForm({ events, songKeys }: { events: EventOption[]; songKeys: string[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  // 空文字 = ライブ名で新しく作る (同名があればそれを使う)
  const [entityId, setEntityId] = useState("");
  const [draft, setDraft] = useState<SetlistDraft>(() => ({
    commonSongs: "",
    performances: [newRow({ key: "init-0" })],
  }));

  const sameName = events.find((e) => e.name === name.trim());

  function handleCreate() {
    if (!name.trim()) {
      setMsg("ライブ名を入力してください");
      return;
    }
    if (draft.performances.some((p) => !p.date)) {
      setMsg("公演の日付を入力してください");
      return;
    }
    setMsg("作成中…");
    startTransition(async () => {
      const setlist = toSetlistInput(draft);
      const res = await createLiveAction({
        name: name.trim(),
        note,
        ...(entityId ? { entityId } : {}),
        performances: setlist.performances,
        commonSongs: setlist.commonSongs,
      });
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      router.push(`/lives/${res.id}`);
    });
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5">
      <label className={labelCls} htmlFor="live-name">
        ライブ名 (記事のタイトル・ドシエ名になります)
      </label>
      <input
        id="live-name"
        className={inputCls}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="日向坂46 ARENA TOUR 2025「MONSTER GROOVE」"
        maxLength={MAX_LIVE_NAME}
      />

      <label className={labelCls} htmlFor="live-entity">
        イベントエンティティ (素材候補に、このエンティティが付いたアセットも出します)
      </label>
      <select
        id="live-entity"
        className={inputCls}
        value={entityId}
        onChange={(e) => setEntityId(e.target.value)}
      >
        <option value="">
          {sameName ? `同名のエンティティ「${sameName.name}」を使う` : "ライブ名で新しく作る"}
        </option>
        {events.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}（アセット {e.assetCount} 件）
          </option>
        ))}
      </select>

      <label className={labelCls} htmlFor="live-note">
        補足 (任意。「セットリスト違いの A / B パターン」など。記事の公演の章に出ます)
      </label>
      <textarea
        id="live-note"
        className={inputCls + " min-h-[4rem]"}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      <span className={labelCls}>公演と披露曲</span>
      <SetlistEditor value={draft} onChange={setDraft} disabled={pending} knownKeys={songKeys} />

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={handleCreate}
          disabled={pending}
          className="h-9 px-4 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800 disabled:opacity-50"
        >
          作成する
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
