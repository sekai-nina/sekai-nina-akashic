"use client";

import { useState, useTransition } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { setSiteVisibilityAction, type SiteVisibilityState } from "../actions";
import { ARTICLE_REVIEW_LABELS, ARTICLE_VISIBILITY_LABELS } from "@/lib/utils";

/**
 * 記事がサイトに出ているかと、その切り替え (#327)。押すと確認を挟んで、その 1 本だけをすぐ push する。
 * 状態の文言は「push 済みか」と `draft` から決める。未 push の間は「未公開」
 */
export function SiteVisibility({
  shortId,
  draft,
  pushed,
  dirty,
  needsReview,
  canPush,
}: {
  shortId: string;
  draft: boolean;
  /** 一度でも GitHub に載ったか (githubSha がある) */
  pushed: boolean;
  /** 未 push の編集があるか */
  dirty: boolean;
  needsReview: boolean;
  /** admin だけが切り替えられる (push と同じ) */
  canPush: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<SiteVisibilityState>(null);
  const [isPending, startTransition] = useTransition();

  const L = ARTICLE_VISIBILITY_LABELS;
  const status = !pushed && !draft ? L.unpushed : draft ? L.hidden : L.published;
  const hide = pushed && !draft;
  const action = hide ? L.hide : pushed ? L.publish : L.publishNow;
  const blocked = !hide && needsReview;

  const run = () =>
    startTransition(async () => {
      const r = await setSiteVisibilityAction(shortId, hide);
      setState(r);
      setConfirming(false);
    });

  return (
    <div className="mt-3 text-sm rounded-lg border border-slate-200 bg-white px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        {draft ? <EyeOff size={14} className="text-slate-400" /> : <Eye size={14} className="text-slate-400" />}
        <span className="text-slate-700">{status}</span>
        {canPush && !confirming && (
          <button
            type="button"
            disabled={isPending || blocked}
            onClick={() => {
              setState(null);
              setConfirming(true);
            }}
            title={blocked ? `${ARTICLE_REVIEW_LABELS.needsReview}の記事は公開できません。編集画面で${ARTICLE_REVIEW_LABELS.markReviewed}を付けてください` : undefined}
            className="ml-auto px-2.5 py-1 rounded border border-slate-300 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {action}
          </button>
        )}
      </div>
      {blocked && canPush && (
        <p className="text-xs text-violet-700">
          {ARTICLE_REVIEW_LABELS.needsReview}なので公開できません。編集画面で「{ARTICLE_REVIEW_LABELS.markReviewed}」を付けて保存してください
        </p>
      )}
      {confirming && (
        <div className="rounded bg-slate-50 border border-slate-200 px-3 py-2 space-y-2">
          <p className="text-xs text-slate-700">
            {hide
              ? "公開サイトの記事ページに出なくなります。本文は公開リポジトリ (GitHub) に残ります。"
              : "この記事を GitHub に push し、公開サイトに出します。"}
            {dirty && " 未 push の編集も一緒に push されます。"}
            この記事 1 本だけをすぐ push します。
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={run}
              disabled={isPending}
              className="inline-flex items-center gap-1 px-3 py-1 rounded bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50"
            >
              {isPending && <Loader2 size={12} className="animate-spin" />}
              {isPending ? "push 中…" : `${action}（push する）`}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={isPending}
              className="px-3 py-1 rounded border border-slate-300 text-xs text-slate-600 hover:bg-white"
            >
              やめる
            </button>
          </div>
        </div>
      )}
      {state && <p className={`text-xs ${state.ok ? "text-emerald-700" : "text-red-700"}`}>{state.ok ? state.message : state.error}</p>}
    </div>
  );
}
