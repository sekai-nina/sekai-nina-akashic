"use client";

import { useState, useTransition } from "react";
import { FOOD_CATEGORY_LABELS } from "@/lib/utils";
import { renameFoodAction, setFoodCategoryAction } from "./actions";

export interface FoodTableRow {
  name: string;
  asIngredient: number;
  asResult: number;
  category: string | null;
}

/**
 * 材料・できあがる味の名前の一覧。分類は選ぶとすぐ保存する。名前の変更は、その名前を使う発見の数を
 * 見せてから全部の発見で書き換える (変更先が既にある名前なら統合)
 */
export function FoodsTable({ rows, canEdit }: { rows: FoodTableRow[]; canEdit: boolean }) {
  const [q, setQ] = useState("");
  const shown = q.trim() ? rows.filter((r) => r.name.includes(q.trim())) : rows;
  const uncategorized = rows.filter((r) => !r.category).length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="名前で絞る"
          aria-label="名前で絞る"
          className="px-3 py-1.5 rounded-md border border-slate-200 bg-white text-sm w-64 max-w-full"
        />
        <span className="text-sm text-slate-500">
          {rows.length} 個{uncategorized > 0 && <span className="text-amber-700"> / 分類がまだ {uncategorized} 個 (上に並べています)</span>}
        </span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="text-left px-3 py-2 font-medium">名前</th>
              <th className="text-right px-3 py-2 font-medium">材料</th>
              <th className="text-right px-3 py-2 font-medium">できあがり</th>
              <th className="text-left px-3 py-2 font-medium">分類</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <FoodRow key={r.name} row={r} canEdit={canEdit} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FoodRow({ row, canEdit }: { row: FoodTableRow; canEdit: boolean }) {
  const [pending, startTransition] = useTransition();
  const [category, setCategory] = useState(row.category ?? "");
  const [renaming, setRenaming] = useState(false);
  const [to, setTo] = useState(row.name);
  // 名前を使う発見の数。1 件の発見で材料とできあがりの両方に出ることはまず無いので、回数の和で見せる
  const uses = row.asIngredient + row.asResult;
  const [msg, setMsg] = useState<string | null>(null);

  function changeCategory(value: string) {
    setCategory(value);
    setMsg("保存中…");
    startTransition(async () => {
      const res = await setFoodCategoryAction(row.name, value);
      setMsg(res.ok ? "保存しました" : `エラー: ${res.error}`);
    });
  }

  function startRename() {
    setRenaming(true);
    setMsg(null);
  }

  function rename() {
    setMsg("書き換え中…");
    startTransition(async () => {
      const res = await renameFoodAction(row.name, to);
      if (res.ok) {
        setRenaming(false);
        setMsg(`${res.changed} 件の発見を書き換えました`);
      } else setMsg(`エラー: ${res.error}`);
    });
  }

  return (
    <tr className="border-t border-slate-100 align-top">
      <td className="px-3 py-2">
        {renaming ? (
          <div className="space-y-1">
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              aria-label={`${row.name} の新しい名前`}
              className="px-2 py-1 rounded-md border border-slate-300 text-sm w-48 max-w-full"
            />
            <p className="text-xs text-slate-500">
              {`「${row.name}」を使う発見 ${uses} 件が変わります。既にある名前にすると統合します。`}
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={rename} disabled={pending || !to.trim() || to.trim() === row.name}
                className="px-2 py-1 rounded-md bg-slate-900 text-white text-xs disabled:opacity-50">
                書き換える
              </button>
              <button type="button" onClick={() => setRenaming(false)} className="px-2 py-1 rounded-md border border-slate-200 text-xs">
                やめる
              </button>
            </div>
          </div>
        ) : (
          <span className="text-slate-900">{row.name}</span>
        )}
        {msg && <div className="text-xs text-slate-500 mt-1" role="status">{msg}</div>}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-slate-600">{row.asIngredient || ""}</td>
      <td className="px-3 py-2 text-right tabular-nums text-slate-600">{row.asResult || ""}</td>
      <td className="px-3 py-2">
        <select
          value={category}
          disabled={!canEdit || pending}
          onChange={(e) => changeCategory(e.target.value)}
          aria-label={`${row.name} の分類`}
          className={"px-2 py-1 rounded-md border text-sm bg-white " + (category ? "border-slate-200" : "border-amber-400")}
        >
          {!category && <option value="">分類がまだ</option>}
          {Object.entries(FOOD_CATEGORY_LABELS).map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2 text-right">
        {canEdit && !renaming && (
          <button type="button" onClick={startRename} className="text-xs text-sky-700 hover:underline">
            名前を変える
          </button>
        )}
      </td>
    </tr>
  );
}
