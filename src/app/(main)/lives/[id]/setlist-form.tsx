"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { LivePerformanceView } from "@/lib/domain/lives";
import { replaceSetlistAction } from "../actions";
import { SetlistEditor, toDraft, toSetlistInput, type SetlistDraft } from "../setlist-editor";

/**
 * 詳細画面の公演の表。保存で丸ごと入れ替える (`replaceSetlist`)。
 * 保存後に RSC が新しい公演 (新規行の ID 付き) を返すので、そのときだけ下書きを組み直す。
 *
 * 「編集中か」は ref で持つ。state にして effect の依存に入れると、保存直後の `dirty=false`
 * で effect が走り、**refresh が返るまでの間だけ保存前の行に戻って**ちらつく
 */
export function SetlistForm({
  liveId,
  commonSongs,
  performances,
}: {
  liveId: string;
  commonSongs: string[];
  performances: LivePerformanceView[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const initial = useMemo(() => toDraft({ commonSongs, performances }), [commonSongs, performances]);
  const [draft, setDraft] = useState<SetlistDraft>(initial);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);

  // サーバーの値が変わったら (保存直後・別タブでの編集) 編集中でない限り追随する
  useEffect(() => {
    if (!dirtyRef.current) setDraft(initial);
  }, [initial]);

  function change(next: SetlistDraft) {
    setDraft(next);
    dirtyRef.current = true;
    setDirty(true);
  }

  function save() {
    if (draft.performances.some((p) => !p.date)) {
      setMsg("公演の日付を入力してください");
      return;
    }
    setMsg("保存中…");
    startTransition(async () => {
      const res = await replaceSetlistAction(liveId, toSetlistInput(draft));
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setMsg(`保存しました (${res.performances} 公演${res.removed > 0 ? `、${res.removed} 件削除` : ""})`);
      dirtyRef.current = false;
      setDirty(false);
      router.refresh();
    });
  }

  return (
    <div>
      <SetlistEditor value={draft} onChange={change} disabled={pending} />
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={pending || !dirty}
          className="h-9 px-4 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800 disabled:opacity-50"
        >
          公演を保存
        </button>
        {dirty && !pending && <span className="text-xs text-amber-700">未保存の変更があります</span>}
        {msg && (
          <span role="status" className="text-xs text-slate-500">
            {msg}
          </span>
        )}
      </div>
    </div>
  );
}
