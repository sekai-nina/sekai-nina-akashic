"use client";

import { useState } from "react";
import Link from "next/link";
import { toggleCheckAction, setItemChecksAction } from "../../coverage/actions";

interface PanelItem {
  sourceKey: string;
  sourceName: string;
  itemKey: string; // url または "YYYY-MM-DD"
  itemTitle: string | null;
  checkedLensKeys: string[];
}

interface LensMeta {
  key: string;
  name: string;
}

/**
 * アセットページ内の観点チェックパネル（v2.4）。
 * このアセットが属するカバレッジアイテム（ブログ記事 / トーク日 / 番組回）に対して、
 * 全アクティブ観点のチップと「残りの観点も確認済みにする」をその場で操作できる。
 * チェックは**アイテム単位**（このアセット単体ではなく記事/日の全体に付く）。
 * viewer は読み取り専用（チップ表示のみ）。
 */
export function AssetCoveragePanel({
  items: initialItems,
  lenses,
  canEdit,
}: {
  items: PanelItem[];
  lenses: LensMeta[];
  canEdit: boolean;
}) {
  const [items, setItems] = useState<PanelItem[]>(initialItems);
  const [msg, setMsg] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);

  function setLocal(idx: number, lensKeys: string[], checked: boolean) {
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== idx) return it;
        const set = new Set(it.checkedLensKeys);
        for (const k of lensKeys) {
          if (checked) set.add(k);
          else set.delete(k);
        }
        return { ...it, checkedLensKeys: [...set] };
      })
    );
  }

  async function toggle(idx: number, lensKey: string, checked: boolean) {
    if (!canEdit) return;
    const item = items[idx];
    setMsg(null);
    setLocal(idx, [lensKey], checked); // 楽観
    const res = await toggleCheckAction({
      lensKey,
      dataSourceKey: item.sourceKey,
      itemKey: item.itemKey,
      checked,
    });
    if (!res.ok) {
      setLocal(idx, [lensKey], !checked);
      setMsg(`エラー: ${res.error}`);
    }
  }

  async function checkRemaining(idx: number) {
    if (!canEdit) return;
    const item = items[idx];
    const set = new Set(item.checkedLensKeys);
    const remaining = lenses.filter((l) => !set.has(l.key)).map((l) => l.key);
    if (remaining.length === 0) return;
    setMsg(null);
    setLocal(idx, remaining, true); // 楽観
    const res = await setItemChecksAction({
      dataSourceKey: item.sourceKey,
      itemKey: item.itemKey,
      lensKeys: remaining,
      checked: true,
    });
    if (!res.ok) {
      setLocal(idx, remaining, false);
      setMsg(`エラー: ${res.error}`);
    }
  }

  // フロート表示: アセットを読みながらスクロール位置に依らずチェックできるよう、
  // 右下固定＋最小化トグル（内容を覆わないように）。
  if (minimized) {
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        className="fixed bottom-4 right-4 z-40 rounded-full bg-slate-800 text-white text-xs px-4 py-2.5 shadow-lg hover:bg-slate-700 transition-colors"
        title="収集カバレッジのチェックパネルを開く"
      >
        ✓ カバレッジ
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 w-80 max-h-[70vh] overflow-y-auto bg-white border border-slate-300 rounded-lg p-4 shadow-xl">
      <div className="flex items-start justify-between mb-1">
        <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
          収集カバレッジ
        </h2>
        <button
          type="button"
          onClick={() => setMinimized(true)}
          className="text-slate-400 hover:text-slate-600 text-xs leading-none px-1"
          title="最小化"
        >
          ―
        </button>
      </div>
      <p className="text-[10px] text-slate-400 mb-3">
        チェックはこのアセット単体ではなく、記事/日のアイテム全体に付きます
      </p>
      <div className="space-y-4">
        {items.map((item, idx) => {
          const checkedSet = new Set(item.checkedLensKeys);
          const complete = lenses.length > 0 && lenses.every((l) => checkedSet.has(l.key));
          return (
            <div key={`${item.sourceKey}:${item.itemKey}`}>
              <div className="text-xs text-slate-600 mb-1.5 min-w-0">
                <Link
                  href={`/coverage/${item.sourceKey}`}
                  className="font-medium text-slate-700 hover:text-slate-900 hover:underline"
                >
                  {item.sourceName}
                </Link>
                <span className="text-slate-400"> / </span>
                <span className="text-slate-500 break-all">
                  {item.itemTitle || item.itemKey}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {lenses.map((l) => {
                  const on = checkedSet.has(l.key);
                  return (
                    <button
                      key={l.key}
                      type="button"
                      disabled={!canEdit}
                      onClick={() => toggle(idx, l.key, !on)}
                      className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors disabled:cursor-default ${
                        on
                          ? "bg-emerald-600 border-emerald-600 text-white"
                          : "bg-white border-slate-200 text-slate-500 hover:border-slate-400 hover:text-slate-700"
                      }`}
                      title={on ? `${l.name} のチェックを外す` : `${l.name} にチェック`}
                    >
                      {on ? "✓ " : ""}
                      {l.name}
                    </button>
                  );
                })}
                {canEdit && !complete && (
                  <button
                    type="button"
                    onClick={() => checkRemaining(idx)}
                    className="text-[11px] px-2 py-0.5 rounded-full border border-slate-300 bg-slate-100 text-slate-600 hover:bg-slate-200 ml-1"
                    title="未チェックの観点をすべて✓"
                  >
                    残りの観点も確認済みにする
                  </button>
                )}
                {complete && (
                  <span className="text-[10px] text-emerald-600 ml-1">全観点 確認済み</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {msg && <p className="text-xs text-rose-600 mt-2">{msg}</p>}
    </div>
  );
}
