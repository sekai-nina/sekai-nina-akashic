"use client";

import { useState, useTransition } from "react";
import { Loader2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WatchView } from "@/lib/domain/x-mentions";
import { WATCH_QUERY_MAX_CHARS } from "@/lib/x-mentions/query";
import { createWatchAction, deleteWatchAction, updateWatchAction, type MentionActionState } from "./actions";

/** サーバーで相対時刻を文字列にしたもの (クライアントで計算すると hydration で食い違う) */
export type WatchItem = WatchView & { lastCheckedLabel: string };

const inputCls =
  "w-full px-3 py-2 rounded-md border border-slate-200 bg-white text-sm text-slate-900 outline-none focus:border-slate-400 font-mono";

/**
 * 監視語の一覧と追加。監視語は X の検索クエリをそのまま書く
 * (`"坂井新奈"` / `にいなちゃん OR にーなちゃん`)。`-is:retweet` と除外ユーザーは実行時に足す。
 */
export function WatchList({ items, canEdit }: { items: WatchItem[]; canEdit: boolean }) {
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<MentionActionState | null>(null);
  const [isPending, startTransition] = useTransition();

  function add() {
    if (isPending || !draft.trim()) return;
    startTransition(async () => {
      const r = await createWatchAction(draft);
      setState(r);
      if (r.ok) setDraft("");
    });
  }

  return (
    <div className="space-y-3">
      {canEdit && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
          className="flex gap-2"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={'例: "坂井新奈"  /  にいなちゃん OR にーなちゃん  /  #坂井新奈 -日向坂46'}
            aria-label="追加する監視語"
            className={inputCls}
            maxLength={WATCH_QUERY_MAX_CHARS}
          />
          <button
            type="submit"
            disabled={isPending || !draft.trim()}
            className="inline-flex items-center gap-1 px-3 py-2 rounded bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50 shrink-0"
          >
            {isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            追加
          </button>
        </form>
      )}
      {state && (
        <p className={`text-xs ${state.ok ? "text-emerald-700" : "text-red-700"}`}>{state.ok ? state.message : state.error}</p>
      )}
      {items.length === 0 ? (
        <p className="text-slate-400 py-6 text-center text-sm">監視語がありません。X の検索クエリをそのまま追加してください。</p>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
          {items.map((w) => (
            <WatchRow key={w.id} item={w} canEdit={canEdit} onResult={setState} />
          ))}
        </div>
      )}
    </div>
  );
}

function WatchRow({
  item,
  canEdit,
  onResult,
}: {
  item: WatchItem;
  canEdit: boolean;
  onResult: (s: MentionActionState) => void;
}) {
  const [query, setQuery] = useState(item.query);
  const [isPending, startTransition] = useTransition();
  // サーバーは連続空白を 1 つに畳んで保存するので、比較も同じ形で行う
  const normalized = query.replace(/\s+/g, " ").trim();
  const dirty = normalized !== item.query;

  function save() {
    if (isPending || !dirty) return;
    startTransition(async () => {
      const r = await updateWatchAction(item.id, { query });
      // 保存できたら入力も保存後の形に揃える (揃えないと「未保存」の見た目が残る)
      if (r.ok) setQuery(normalized);
      onResult(r);
    });
  }
  function toggle() {
    if (isPending) return;
    startTransition(async () => onResult(await updateWatchAction(item.id, { enabled: !item.enabled })));
  }
  function remove() {
    if (isPending) return;
    if (!window.confirm(`「${item.query}」を削除しますか？（拾ったツイート ${item.hitCount} 件も消えます）`)) return;
    startTransition(async () => onResult(await deleteWatchAction(item.id)));
  }

  return (
    <div className={cn("px-4 py-3", isPending && "opacity-50", !item.enabled && "bg-slate-50")}>
      <div className="flex items-center gap-2">
        <span
          className={`inline-block w-2 h-2 rounded-full shrink-0 ${item.enabled ? "bg-green-500" : "bg-slate-300"}`}
          title={item.enabled ? "有効" : "無効"}
        />
        {canEdit ? (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              }
            }}
            aria-label="監視語"
            className={cn(inputCls, dirty && "border-amber-400")}
            maxLength={WATCH_QUERY_MAX_CHARS}
          />
        ) : (
          <span className="font-mono text-sm text-slate-900 flex-1 truncate">{item.query}</span>
        )}
        {canEdit && (
          <div className="flex gap-1 shrink-0">
            {dirty && (
              <button type="button" onClick={save} disabled={isPending} className="text-xs px-2 py-1 rounded bg-slate-900 text-white hover:bg-slate-800">
                保存
              </button>
            )}
            <button type="button" onClick={toggle} disabled={isPending} className="text-xs px-2 py-1 rounded text-slate-500 hover:bg-slate-100">
              {item.enabled ? "無効にする" : "有効にする"}
            </button>
            <button type="button" onClick={remove} disabled={isPending} className="text-xs px-2 py-1 rounded text-red-600 hover:bg-red-50">
              削除
            </button>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 pl-4 text-xs text-slate-400">
        <span>ヒット {item.hitCount} 件</span>
        <span>{item.lastCheckedLabel}</span>
        {item.lastError && <span className="text-red-600">前回の実行に失敗: {item.lastError}</span>}
      </div>
    </div>
  );
}
