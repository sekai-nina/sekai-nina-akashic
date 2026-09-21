"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useMemo } from "react";
import type { LivePerformanceView, SetlistInput } from "@/lib/domain/lives";
import { joinSongs, MAX_PERFORMANCES, splitSongs } from "@/lib/live/config";
import { normalizeSongTitle } from "@/lib/songs/normalize";

/**
 * 公演の表の編集用の行。曲は「A / B / C」の 1 行のまま持ち、保存時に分割する
 * (入力のたびに分割すると末尾の ` / ` が打てない)
 */
export interface PerformanceRow {
  /** 既存の公演の ID (新しい行は undefined) */
  id?: string;
  /** 画面内で行を追跡するためのキー */
  key: string;
  date: string;
  venue: string;
  label: string;
  note: string;
  songs: string;
  centerSongs: string;
}

export interface SetlistDraft {
  commonSongs: string;
  performances: PerformanceRow[];
}

let seq = 0;
/**
 * 行を作る。`key` を渡さなければ連番で振る。
 * **初期表示の行には決まったキーを渡すこと** (既存行は ID、作成フォームの空行は固定文字列)。
 * 連番はサーバーとクライアントで別々に進むので、SSR で振った値がハイドレーションで食い違う
 */
export function newRow(init: Partial<PerformanceRow> = {}): PerformanceRow {
  seq += 1;
  return {
    key: `row-${seq}`,
    date: "",
    venue: "",
    label: "",
    note: "",
    songs: "",
    centerSongs: "",
    ...init,
  };
}

/** DB の公演 → 編集用の行 */
export function toDraft(live: { commonSongs: string[]; performances: LivePerformanceView[] }): SetlistDraft {
  return {
    commonSongs: joinSongs(live.commonSongs),
    performances: live.performances.map((p) =>
      newRow({
        key: p.id,
        id: p.id,
        date: p.date,
        venue: p.venue,
        label: p.label,
        note: p.note,
        songs: joinSongs(p.songs),
        centerSongs: joinSongs(p.centerSongs),
      })
    ),
  };
}

/** 編集用の行 → 保存する形 (曲の 1 行入力をここで分割する) */
export function toSetlistInput(draft: SetlistDraft): SetlistInput & { commonSongs: string[] } {
  return {
    commonSongs: splitSongs(draft.commonSongs),
    performances: draft.performances.map((r) => ({
      ...(r.id ? { id: r.id } : {}),
      date: r.date,
      venue: r.venue,
      label: r.label,
      note: r.note,
      songs: splitSongs(r.songs),
      centerSongs: splitSongs(r.centerSongs),
    })),
  };
}

const inputCls =
  "w-full px-2 py-1 rounded-md border border-slate-200 bg-white text-sm text-slate-900 outline-none focus:border-slate-400";
const labelCls = "block text-[11px] text-slate-500 mb-0.5";

/**
 * 公演と披露曲の編集 (作成フォームと詳細画面で共用)。
 * 「共通披露曲」はライブ全体、各行の「追加曲」は公演限定、「センター曲」は公演ごと。
 * 既存の一覧記事 (`【N年目】参加したライブ・披露曲一覧`) の表と同じ列構成にしてある。
 */
export function SetlistEditor({
  value,
  onChange,
  disabled,
  knownKeys,
}: {
  value: SetlistDraft;
  onChange: (next: SetlistDraft) => void;
  disabled?: boolean;
  /**
   * 曲マスタにある曲の名寄せキー (#167)。入力中の曲でマスタに無いものを行の下に出す
   * (誤字に気づけるように)。保存は止めない (ライブ限定アレンジなど未収録の曲もある)
   */
  knownKeys?: string[];
}) {
  const rows = value.performances;
  const known = useMemo(() => new Set(knownKeys ?? []), [knownKeys]);
  /** マスタに無い曲 (knownKeys が無ければ判定しない) */
  const unknownIn = (text: string): string[] =>
    known.size === 0 ? [] : splitSongs(text).filter((t) => !known.has(normalizeSongTitle(t)));

  function patch(i: number, p: Partial<PerformanceRow>) {
    onChange({ ...value, performances: rows.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    onChange({ ...value, performances: next });
  }
  function remove(i: number) {
    onChange({ ...value, performances: rows.filter((_, j) => j !== i) });
  }
  function add() {
    if (rows.length >= MAX_PERFORMANCES) return;
    // 連日公演が多いので、前の行の会場を引き継ぐ
    const prev = rows[rows.length - 1];
    onChange({ ...value, performances: [...rows, newRow({ venue: prev?.venue ?? "" })] });
  }

  return (
    <div>
      <label className={labelCls} htmlFor="live-common-songs">
        共通披露曲 (全公演で披露した曲。「A / B / C」のようにスラッシュ区切り)
      </label>
      <input
        id="live-common-songs"
        className={inputCls}
        value={value.commonSongs}
        onChange={(e) => onChange({ ...value, commonSongs: e.target.value })}
        placeholder="NO WAR in the future 2020 / キツネ / 空飛ぶ車"
        disabled={disabled}
      />
      <UnknownSongs titles={unknownIn(value.commonSongs)} />

      <div className="mt-3 space-y-2">
        {rows.map((r, i) => (
          <fieldset key={r.key} className="rounded-md border border-slate-200 p-3">
            <legend className="px-1 text-[11px] text-slate-500">
              {i + 1} 公演目{r.id ? "" : " (新規)"}
            </legend>
            <div className="grid grid-cols-1 sm:grid-cols-[9.5rem_1fr_7rem] gap-2">
              <div>
                <label className={labelCls} htmlFor={`${r.key}-date`}>日付</label>
                <input
                  id={`${r.key}-date`}
                  type="date"
                  className={inputCls}
                  value={r.date}
                  onChange={(e) => patch(i, { date: e.target.value })}
                  disabled={disabled}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor={`${r.key}-venue`}>会場</label>
                <input
                  id={`${r.key}-venue`}
                  className={inputCls}
                  value={r.venue}
                  onChange={(e) => patch(i, { venue: e.target.value })}
                  placeholder="セキスイハイムスーパーアリーナ（宮城）"
                  disabled={disabled}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor={`${r.key}-label`}>呼び分け</label>
                <input
                  id={`${r.key}-label`}
                  className={inputCls}
                  value={r.label}
                  onChange={(e) => patch(i, { label: e.target.value })}
                  placeholder="昼公演"
                  disabled={disabled}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
              <div>
                <label className={labelCls} htmlFor={`${r.key}-songs`}>追加曲 (この公演だけ)</label>
                <input
                  id={`${r.key}-songs`}
                  className={inputCls}
                  value={r.songs}
                  onChange={(e) => patch(i, { songs: e.target.value })}
                  placeholder="One choice"
                  disabled={disabled}
                />
                <UnknownSongs titles={unknownIn(r.songs)} />
              </div>
              <div>
                <label className={labelCls} htmlFor={`${r.key}-center`}>センター曲</label>
                <input
                  id={`${r.key}-center`}
                  className={inputCls}
                  value={r.centerSongs}
                  onChange={(e) => patch(i, { centerSongs: e.target.value })}
                  placeholder="ソンナコトナイヨ"
                  disabled={disabled}
                />
                <UnknownSongs titles={unknownIn(r.centerSongs)} />
              </div>
            </div>
            <div className="flex items-end gap-2 mt-2">
              <div className="flex-1">
                <label className={labelCls} htmlFor={`${r.key}-note`}>備考</label>
                <input
                  id={`${r.key}-note`}
                  className={inputCls}
                  value={r.note}
                  onChange={(e) => patch(i, { note: e.target.value })}
                  placeholder="アンコールに JOYFUL LOVE を追加"
                  disabled={disabled}
                />
              </div>
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={disabled || i === 0}
                className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40"
                aria-label={`${i + 1} 公演目を上へ`}
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={disabled || i === rows.length - 1}
                className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40"
                aria-label={`${i + 1} 公演目を下へ`}
              >
                <ArrowDown size={14} />
              </button>
              <button
                type="button"
                onClick={() => remove(i)}
                disabled={disabled || rows.length <= 1}
                className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-slate-200 text-red-600 hover:bg-red-50 disabled:opacity-40"
                aria-label={`${i + 1} 公演目を削除`}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </fieldset>
        ))}
      </div>

      <button
        type="button"
        onClick={add}
        disabled={disabled || rows.length >= MAX_PERFORMANCES}
        className="mt-2 inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 underline underline-offset-2 disabled:opacity-40"
      >
        <Plus size={12} /> 公演を足す
      </button>
    </div>
  );
}

/** マスタに無い曲の注意書き。無ければ何も出さない */
function UnknownSongs({ titles }: { titles: string[] }) {
  if (titles.length === 0) return null;
  return (
    <p className="mt-0.5 text-[11px] text-amber-700">
      曲マスタに無い: {titles.join(" / ")} (誤字なら直してください。未収録の曲ならそのまま保存できます)
    </p>
  );
}
