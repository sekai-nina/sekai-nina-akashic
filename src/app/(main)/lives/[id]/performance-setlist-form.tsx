"use client";

import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { LivePerformanceView, LiveSetlistItemView } from "@/lib/domain/lives";
import { MAX_SETLIST_ITEMS, parseSetlistText, SETLIST_SECTIONS } from "@/lib/live/setlist";
import { normalizeSongTitle } from "@/lib/songs/normalize";
import { replacePerformanceSetlistAction } from "../actions";

/**
 * 公演ごとのセトリ (出ていない曲も含めた全曲)。
 *
 * 作業の流れ: 公式やファンの投稿のセトリを貼る → 「読み込む」で曲の行になる → 坂井新奈が出ていない曲の
 * 「参加」を外し、センター曲に印を付ける → どこから写したか (出典) を書く → 保存。
 * 2 公演目からは「ほかの公演からコピー」して差分だけ直す (出典も写る)。
 * 保存すると、上の表の共通披露曲 / 追加曲 / センター曲がセトリから組み直される (参加した曲だけ)。
 */
export function PerformanceSetlistForm({
  liveId,
  performances,
  participation,
  knownKeys,
}: {
  liveId: string;
  performances: LivePerformanceView[];
  /** 曲マスタの「参加楽曲か」(名寄せキー → member / none)。貼ったときの参加の初期値 */
  participation: Record<string, string>;
  knownKeys: string[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="divide-y divide-slate-100 border-y border-slate-100">
      {performances.map((p, i) => (
        <li key={p.id}>
          <button
            type="button"
            onClick={() => setOpen(open === p.id ? null : p.id)}
            className="w-full flex items-center gap-2 py-2 text-left text-sm hover:bg-slate-50"
            aria-expanded={open === p.id}
          >
            {open === p.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="font-medium text-slate-900 tabular-nums">{p.date}</span>
            <span className="text-slate-600 truncate">
              {p.venue}
              {p.label && ` ${p.label}`}
            </span>
            <span className="ml-auto shrink-0 text-xs text-slate-500">{summary(p.setlist)}</span>
          </button>
          {open === p.id && (
            <PerformanceEditor
              liveId={liveId}
              performance={p}
              others={performances.filter((o, j) => j !== i && o.setlist.length > 0)}
              participation={participation}
              knownKeys={knownKeys}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

function summary(setlist: LiveSetlistItemView[]): string {
  if (setlist.length === 0) return "セトリ未入力";
  const joined = setlist.filter((s) => s.participated).length;
  const center = setlist.filter((s) => s.center).length;
  return `${setlist.length} 曲 · 参加 ${joined}${center > 0 ? ` · センター ${center}` : ""}`;
}

interface Row extends LiveSetlistItemView {
  key: string;
}

let seq = 0;
const toRows = (items: LiveSetlistItemView[]): Row[] => items.map((it) => ({ ...it, key: `s-${++seq}` }));

const inputCls =
  "w-full px-2 py-1 rounded-md border border-slate-200 bg-white text-sm text-slate-900 outline-none focus:border-slate-400";
const iconBtn =
  "h-7 w-7 inline-flex items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40";

function PerformanceEditor({
  liveId,
  performance,
  others,
  participation,
  knownKeys,
}: {
  liveId: string;
  performance: LivePerformanceView;
  others: LivePerformanceView[];
  participation: Record<string, string>;
  knownKeys: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rows, setRows] = useState<Row[]>(() => toRows(performance.setlist));
  const [paste, setPaste] = useState("");
  const [sourceLabel, setSourceLabel] = useState(performance.setlistSource.label);
  const [sourceUrl, setSourceUrl] = useState(performance.setlistSource.url);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [msg, setMsg] = useState<string | null>(null);
  const known = useMemo(() => new Set(knownKeys), [knownKeys]);

  // 保存後の refresh で返る行 (曲名は曲マスタの表記に寄っている) に、編集中でない限り追随する。
  // 「編集中か」は ref で持つ (SetlistForm と同じ。state だと保存直後に古い行へ一瞬戻る)
  useEffect(() => {
    if (!dirtyRef.current) {
      setRows(toRows(performance.setlist));
      setSourceLabel(performance.setlistSource.label);
      setSourceUrl(performance.setlistSource.url);
    }
  }, [performance.setlist, performance.setlistSource]);

  function markDirty() {
    dirtyRef.current = true;
    setDirty(true);
  }

  function change(next: Row[]) {
    setRows(next);
    markDirty();
  }
  function patch(i: number, p: Partial<Row>) {
    change(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    change(next);
  }
  /** 貼ったセトリを行にする。参加の初期値は曲マスタ (参加していない曲だけ外す) */
  function load() {
    const parsed = parseSetlistText(paste);
    if (parsed.length === 0) {
      setMsg("曲を読み取れませんでした");
      return;
    }
    const dropped = Math.max(0, parsed.length - MAX_SETLIST_ITEMS);
    change(
      toRows(
        parsed.slice(0, MAX_SETLIST_ITEMS).map((l) => ({
          title: l.title,
          section: l.section,
          participated: participation[normalizeSongTitle(l.title)] !== "none",
          center: false,
        }))
      )
    );
    setPaste("");
    setMsg(
      `${parsed.length - dropped} 曲を読み込みました${dropped > 0 ? ` (上限 ${MAX_SETLIST_ITEMS} 曲を超えた ${dropped} 曲は落としました)` : ""}。参加とセンターを確かめて保存してください`
    );
  }
  function copyFrom(id: string) {
    const src = others.find((o) => o.id === id);
    if (!src) return;
    change(toRows(src.setlist));
    setSourceLabel(src.setlistSource.label);
    setSourceUrl(src.setlistSource.url);
  }
  function save() {
    setMsg("保存中…");
    startTransition(async () => {
      const res = await replacePerformanceSetlistAction(
        liveId,
        performance.id,
        rows.map(({ title, section, participated, center }) => ({ title, section, participated, center })),
        { label: sourceLabel, url: sourceUrl }
      );
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setMsg(`保存しました (${res.songs} 曲 · 参加 ${res.participated}${res.center > 0 ? ` · センター ${res.center}` : ""})`);
      dirtyRef.current = false;
      setDirty(false);
      router.refresh();
    });
  }

  return (
    <div className="pb-4 pl-6">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <textarea
          className={`${inputCls} min-h-24 font-mono text-xs`}
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder={"セトリを貼り付け (1 行 1 曲。M1 / EN1 などの番号・MC・「アンコール」の見出しはそのままでよい)\nM1 円周率\nM2 どこまでが道なんだ？\nEN1 ママのドレス"}
          disabled={pending}
        />
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={load}
            disabled={pending || !paste.trim()}
            className="h-8 px-3 rounded-md border border-slate-300 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            読み込む{rows.length > 0 ? " (置き換え)" : ""}
          </button>
          {others.length > 0 && (
            <select
              className="h-8 px-2 rounded-md border border-slate-300 text-xs text-slate-700 bg-white"
              value=""
              onChange={(e) => copyFrom(e.target.value)}
              disabled={pending}
              aria-label="ほかの公演のセトリをコピー"
            >
              <option value="">ほかの公演からコピー…</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.date} {o.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {rows.length > 0 && (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-[11px] text-slate-500 text-left">
              <th className="w-8 font-normal">#</th>
              <th className="font-normal">曲名</th>
              <th className="w-28 font-normal">区切り</th>
              <th className="w-12 font-normal text-center">参加</th>
              <th className="w-14 font-normal text-center">センター</th>
              <th className="w-24" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key} className={r.participated || r.center ? "" : "text-slate-400"}>
                <td className="text-xs tabular-nums text-slate-400">{i + 1}</td>
                <td className="py-0.5 pr-2">
                  <input
                    className={inputCls}
                    value={r.title}
                    onChange={(e) => patch(i, { title: e.target.value })}
                    disabled={pending}
                    aria-label={`${i + 1} 曲目の曲名`}
                  />
                  {r.title.trim() && !known.has(normalizeSongTitle(r.title)) && (
                    <span className="text-[11px] text-amber-700">曲マスタに無い曲です (誤字なら直してください)</span>
                  )}
                </td>
                <td className="pr-2">
                  <select
                    className="h-7 w-full px-1 rounded-md border border-slate-200 bg-white text-xs"
                    value={r.section}
                    onChange={(e) => patch(i, { section: e.target.value })}
                    disabled={pending}
                    aria-label={`${i + 1} 曲目の区切り`}
                  >
                    {SETLIST_SECTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s || "本編"}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="text-center">
                  <input
                    type="checkbox"
                    checked={r.participated || r.center}
                    onChange={(e) => patch(i, { participated: e.target.checked, center: e.target.checked && r.center })}
                    disabled={pending}
                    aria-label={`${i + 1} 曲目に坂井新奈が参加`}
                  />
                </td>
                <td className="text-center">
                  <input
                    type="checkbox"
                    checked={r.center}
                    onChange={(e) => patch(i, { center: e.target.checked, participated: e.target.checked || r.participated })}
                    disabled={pending}
                    aria-label={`${i + 1} 曲目で坂井新奈がセンター`}
                  />
                </td>
                <td className="text-right whitespace-nowrap">
                  <button type="button" className={iconBtn} onClick={() => move(i, -1)} disabled={pending || i === 0} aria-label="上へ">
                    <ArrowUp size={12} />
                  </button>{" "}
                  <button type="button" className={iconBtn} onClick={() => move(i, 1)} disabled={pending || i === rows.length - 1} aria-label="下へ">
                    <ArrowDown size={12} />
                  </button>{" "}
                  <button type="button" className={`${iconBtn} text-red-600`} onClick={() => change(rows.filter((_, j) => j !== i))} disabled={pending} aria-label="削除">
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {rows.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-[14rem_1fr]">
          <label className="text-xs text-slate-600">
            セトリの出典 (必須)
            <input
              className={`${inputCls} mt-0.5`}
              value={sourceLabel}
              onChange={(e) => {
                setSourceLabel(e.target.value);
                markDirty();
              }}
              placeholder="Sakamichi Universe / 公式ブログ 等"
              maxLength={100}
              disabled={pending}
            />
          </label>
          <label className="text-xs text-slate-600">
            出典の URL (任意)
            <input
              className={`${inputCls} mt-0.5`}
              value={sourceUrl}
              onChange={(e) => {
                setSourceUrl(e.target.value);
                markDirty();
              }}
              placeholder="https://…"
              inputMode="url"
              maxLength={1000}
              disabled={pending}
            />
          </label>
          <p className="sm:col-span-2 text-[11px] text-slate-500">
            どこから写したかを残します。公開サイトではセトリの下に「セトリ出典」として出ます
          </p>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => change([...rows, ...toRows([{ title: "", section: rows[rows.length - 1]?.section ?? "", participated: true, center: false }])])}
          disabled={pending || rows.length >= MAX_SETLIST_ITEMS}
          className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 underline underline-offset-2 disabled:opacity-40"
        >
          <Plus size={12} /> 曲を足す
        </button>
        <button
          type="button"
          onClick={save}
          disabled={pending || !dirty || rows.some((r) => !r.title.trim()) || (rows.length > 0 && !sourceLabel.trim())}
          className="h-8 px-4 rounded-md bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50"
        >
          セトリを保存
        </button>
        {rows.length === 0 && performance.setlist.length > 0 && dirty && (
          <span className="text-xs text-amber-700">空で保存するとこの公演のセトリを消します</span>
        )}
        {dirty && !pending && rows.length > 0 && !sourceLabel.trim() && (
          <span className="text-xs text-amber-700">出典を入れると保存できます</span>
        )}
        {dirty && !pending && rows.length > 0 && sourceLabel.trim() && (
          <span className="text-xs text-amber-700">未保存の変更があります</span>
        )}
        {msg && (
          <span role="status" className="text-xs text-slate-500">
            {msg}
          </span>
        )}
      </div>
    </div>
  );
}
