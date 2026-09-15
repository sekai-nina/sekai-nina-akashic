"use client";

import { useState, useTransition } from "react";
import { Loader2, UploadCloud } from "lucide-react";
import { pushArticlesAction, type PushActionState } from "./actions";

/**
 * push の実行フォーム。件名は任意 (空なら既定の `:dog2: akashic から記事を更新 (N 本)`)。
 *
 * Server Action が `revalidatePath` するので、実行後はページが作り直される
 * (push 済みの記事が一覧から消える)。結果は state に残して表示し続ける。
 * 件名は成功したときだけ消す (422 で「もう一度」となったときに打ち直させない)。
 */
export function PushForm({
  count,
  unchangedCount,
  defaultSubject,
}: {
  count: number;
  unchangedCount: number;
  defaultSubject: string;
}) {
  const [subject, setSubject] = useState("");
  const [state, setState] = useState<PushActionState | null>(null);
  const [isPending, startTransition] = useTransition();

  const nothingToDo = count === 0 && unchangedCount === 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (nothingToDo || isPending) return;
    startTransition(async () => {
      const r = await pushArticlesAction(subject);
      setState(r);
      if (r.ok) setSubject("");
    });
  }

  return (
    <form onSubmit={submit} className="bg-white border border-slate-200 rounded-lg p-4 mb-6">
      <label className="block text-xs font-semibold text-slate-600 mb-1" htmlFor="push-subject">
        コミットの件名 (空なら既定)
      </label>
      <input
        id="push-subject"
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder={defaultSubject}
        disabled={isPending}
        maxLength={100}
        className="w-full border border-slate-300 rounded px-3 py-1.5 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50"
      />
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="submit"
          disabled={nothingToDo || isPending}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
        >
          {isPending ? <Loader2 size={14} className="animate-spin" /> : <UploadCloud size={14} />}
          {isPending
            ? "push 中…"
            : count > 0
              ? `${count} 本を 1 コミットで push`
              : `未 push の印を外す (${unchangedCount} 本)`}
        </button>
        {count > 0 && (
          <span className="text-xs text-slate-500">push すると GitHub Actions が公開サイトを再ビルドします</span>
        )}
      </div>

      {state && (
        <div
          className={`mt-4 text-sm rounded px-3 py-2 ${
            !state.ok || state.result.dbError ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-800"
          }`}
        >
          {state.ok ? (
            <>
              {state.result.commit ? (
                <>
                  {state.result.pushed} 本を push しました:{" "}
                  <a
                    href={state.result.commit.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline font-mono"
                  >
                    {state.result.commit.commitSha.slice(0, 7)}
                  </a>
                </>
              ) : (
                <>push する記事はありませんでした</>
              )}
              {state.result.unchanged > 0 && <> ・ 内容が同じだった {state.result.unchanged} 本は未 push を解除しました</>}
              {state.result.blocked > 0 && <> ・ 公開以外の出典があり除外 {state.result.blocked} 本</>}
              {state.result.conflicts > 0 && <> ・ 衝突で除外 {state.result.conflicts} 本</>}
              {state.result.dbError && (
                <p className="mt-1">
                  <strong>コミットは GitHub に載りましたが、DB の更新に失敗しました:</strong> {state.result.dbError}
                  <br />
                  次回の push ではこれらの記事が衝突扱いになります。checkout を pull して再取り込みしてください
                </p>
              )}
            </>
          ) : (
            <>push に失敗しました: {state.error}</>
          )}
        </div>
      )}
    </form>
  );
}
