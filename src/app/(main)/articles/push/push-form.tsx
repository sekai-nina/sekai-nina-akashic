"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Loader2, UploadCloud } from "lucide-react";
import { pushArticlesAction, type PushActionState } from "./actions";
import { ARTICLE_REVIEW_LABELS } from "@/lib/utils";

export interface PushableArticle {
  shortId: string;
  title: string;
  path: string;
  /** GitHub 側にまだ無いファイル */
  isNew: boolean;
  /** 「AI 書きたて (未確認)」。選べない (#327) */
  needsReview: boolean;
}

/**
 * push の実行フォームと「push 可」の一覧 (#328)。
 *
 * 一覧の各行にチェックがあり、初めはすべて外れている。選んだ記事だけを 1 コミットで push する。
 * 「内容が同じ」記事はコミットに載らず未 push の印だけ外すものなので、選ばなくても毎回一緒に送る。
 * 件名は任意 (空なら既定の `:dog2: akashic から記事を更新 (N 本)`)。
 *
 * Server Action が `revalidatePath` するので、実行後はページが作り直される
 * (push 済みの記事が一覧から消える)。結果は state に残して表示し続ける。
 * 件名と選択は成功したときだけ消す (422 で「もう一度」となったときに選び直させない)。
 */
export function PushForm({
  pushable,
  unchangedShortIds,
  defaultSubjectFor,
}: {
  pushable: PushableArticle[];
  unchangedShortIds: string[];
  /** 本数 → 既定の件名 */
  defaultSubjectFor: Record<number, string>;
}) {
  const [subject, setSubject] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [state, setState] = useState<PushActionState | null>(null);
  const [isPending, startTransition] = useTransition();

  // ページが作り直されて消えた記事は選択から外す
  const selectable = pushable.filter((a) => !a.needsReview);
  const chosen = selectable.filter((a) => selected.has(a.shortId));
  const count = chosen.length;
  const nothingToDo = count === 0 && unchangedShortIds.length === 0;
  const allChecked = selectable.length > 0 && count === selectable.length;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (nothingToDo || isPending) return;
    startTransition(async () => {
      const r = await pushArticlesAction(subject, [...chosen.map((a) => a.shortId), ...unchangedShortIds]);
      setState(r);
      if (r.ok) {
        setSubject("");
        setSelected(new Set());
      }
    });
  }

  return (
    <>
      <form onSubmit={submit} className="bg-white border border-slate-200 rounded-lg p-4 mb-6">
        <label className="block text-xs font-semibold text-slate-600 mb-1" htmlFor="push-subject">
          コミットの件名 (空なら既定)
        </label>
        <input
          id="push-subject"
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={defaultSubjectFor[count] ?? ""}
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
                ? `選んだ ${count} 本を 1 コミットで push`
                : unchangedShortIds.length > 0
                  ? `未 push の印を外す (内容が同じ ${unchangedShortIds.length} 本)`
                  : "下の一覧から push する記事を選んでください"}
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

      {pushable.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-slate-700 mb-1 flex items-center gap-2">
            push 可
            <span className="text-xs px-1.5 py-0.5 rounded font-normal bg-emerald-100 text-emerald-700">
              {pushable.length} 本
            </span>
            <label className="ml-auto inline-flex items-center gap-1.5 text-xs font-normal text-slate-600">
              <input
                type="checkbox"
                checked={allChecked}
                disabled={isPending}
                onChange={() => setSelected(allChecked ? new Set() : new Set(selectable.map((a) => a.shortId)))}
              />
              すべて選ぶ
            </label>
          </h2>
          <p className="text-xs text-slate-500 mb-2">
            push する記事にチェックを入れてください。選ばなかった記事は未 push のまま残ります。
            {ARTICLE_REVIEW_LABELS.needsReview}の記事は、編集画面で確認済みにするまで選べません
          </p>
          <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
            {pushable.map((a) => (
              <label key={a.shortId} className="px-4 py-2.5 flex items-baseline gap-2 flex-wrap cursor-pointer hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={!a.needsReview && selected.has(a.shortId)}
                  disabled={isPending || a.needsReview}
                  onChange={() => toggle(a.shortId)}
                  className="self-center"
                />
                <Link
                  href={`/articles/${a.shortId}`}
                  onClick={(e) => e.stopPropagation()}
                  className="font-medium text-slate-900 hover:underline"
                >
                  {a.title || a.path}
                </Link>
                <span className="text-xs text-slate-400">{a.path}</span>
                {a.needsReview && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">
                    {ARTICLE_REVIEW_LABELS.needsReview}・
                    <Link href={`/articles/${a.shortId}/edit`} onClick={(e) => e.stopPropagation()} className="underline">
                      確認する
                    </Link>
                  </span>
                )}
                {a.isNew && <span className="text-xs text-slate-600 ml-auto">新規ファイル</span>}
              </label>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
