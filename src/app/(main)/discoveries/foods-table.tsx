"use client";

import { useState, useTransition } from "react";
import { FOOD_CATEGORY_LABELS } from "@/lib/utils";
import { regenerateFoodIconAction, renameFoodAction, setFoodCategoryAction } from "./actions";

export interface FoodTableRow {
  name: string;
  asIngredient: number;
  asResult: number;
  category: string | null;
  iconUrl: string | null;
  iconNote: string;
  iconFailures: number;
  iconBlocked: boolean;
}

/**
 * 材料・できあがる味の名前の一覧。分類は選ぶとすぐ保存する。アイコン (#436) は cron が作り、ここで指示を付けて作り直せる (作ったものがサイトの次のビルドで出る)。名前の変更は、その名前を使う発見の数を
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
              <th className="text-left px-3 py-2 font-medium">アイコン</th>
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
        <FoodIcon row={row} canEdit={canEdit} />
      </td>
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

/** cron の上限 (`FOOD_ICON_MAX_FAILURES`) と同じ。クライアントから domain を読まないよう写しておく */
const ICON_MAX_FAILURES = 3;

/** アイコンと作り直し。指示は次からの作り直しでも使い続ける */
function FoodIcon({ row, canEdit }: { row: FoodTableRow; canEdit: boolean }) {
  const [pending, startTransition] = useTransition();
  // ここで作ったものを優先し、無ければ props (cron が作ったものは画面の描き直しで入る)
  const [madeUrl, setMadeUrl] = useState<string | null>(null);
  const url = madeUrl ?? row.iconUrl;
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(row.iconNote);
  const [msg, setMsg] = useState<string | null>(null);

  function regenerate() {
    const had = !!url;
    setMsg("作っています (20 秒ほど)…");
    startTransition(async () => {
      const res = await regenerateFoodIconAction(row.name, note);
      if (res.ok) {
        setMadeUrl(res.url);
        setOpen(false);
        setMsg(`${had ? "作り直しました" : "作りました"} (サイトには次のビルドで出ます)`);
      } else setMsg(`エラー: ${res.error}`);
    });
  }

  return (
    <div className="space-y-1 w-40">
      {url ? (
        // R2 の画像。next/image の最適化は要らない (256px の webp)
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={`${row.name} のアイコン`} width={48} height={48} className="h-12 w-12" />
      ) : (
        <div className="h-12 w-12 rounded-md border border-dashed border-slate-300 grid place-items-center text-[10px] text-slate-400 text-center leading-tight whitespace-pre-line">
          {row.iconBlocked
            ? "機密の\nため\n作らない"
            : !row.category
              ? "分類が\nまだ"
              : row.iconFailures >= ICON_MAX_FAILURES
                ? "作れな\nかった"
                : "作る\n待ち"}
        </div>
      )}
      {canEdit && row.category && !row.iconBlocked && !open && (
        <button type="button" onClick={() => setOpen(true)} disabled={pending} className="text-xs text-sky-700 hover:underline">
          {url ? "作り直す" : "いま作る"}
        </button>
      )}
      {open && (
        <div className="space-y-1">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={pending}
            rows={2}
            maxLength={200}
            placeholder="直してほしい点 (例: 葉っぱではなく焼き菓子のお饅頭に)"
            aria-label={`${row.name} のアイコンを直す指示`}
            className="w-full px-2 py-1 rounded-md border border-slate-300 text-xs"
          />
          <div className="flex gap-2">
            <button type="button" onClick={regenerate} disabled={pending}
              className="px-2 py-1 rounded-md bg-slate-900 text-white text-xs disabled:opacity-50">
              作る
            </button>
            <button type="button" onClick={() => setOpen(false)} disabled={pending} className="px-2 py-1 rounded-md border border-slate-200 text-xs">
              やめる
            </button>
          </div>
        </div>
      )}
      {msg && <div className="text-xs text-slate-500" role="status">{msg}</div>}
    </div>
  );
}
