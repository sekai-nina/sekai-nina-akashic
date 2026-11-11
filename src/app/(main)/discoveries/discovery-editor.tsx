"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import type { DiscoveryConfidenceValue as Confidence } from "@/lib/discoveries/core";
import { DISCOVERY_CONFIDENCE_LABELS } from "@/lib/utils";
import { saveBlogAction } from "./actions";

const inputCls =
  "w-full px-2 py-1 rounded-md border border-slate-200 bg-white text-sm text-slate-900 outline-none focus:border-slate-400";
const labelCls = "block text-[11px] text-slate-500 mb-0.5";

export interface EditorBlog {
  assetId: string;
  title: string;
  date: string;
  url: string | null;
  excerpt: string;
  discoveries: {
    no: number;
    heading: string;
    excerpt: string;
    isFood: boolean;
    ingredients: string[];
    result: string | null;
    confidence: Confidence;
  }[];
}

interface Draft {
  /** 画面の中だけの識別子 (React の key) */
  uid: number;
  /** 元の通し番号 (足した発見は null) */
  no: number | null;
  heading: string;
  excerpt: string;
  isFood: boolean;
  /** 「、」区切りの文字列で持つ (保存時に配列にする) */
  ingredients: string;
  result: string;
  confidence: Confidence;
}

/** 材料の入力 (「、」「,」「＋」「・」区切り) を配列にする */
function splitNames(s: string): string[] {
  return [...new Set(s.split(/[、,，+＋・]/).map((x) => x.trim()).filter(Boolean))];
}

/** 画面を開いてすぐの ⌘↵ は受け付けない (前のブログで押した・押しっぱなしのキーで次のブログを確定しない) */
const KEY_GUARD_MS = 800;

/**
 * ブログ 1 本の発見を直す。確認待ちでは「確定して次へ」、すべてタブから開いたときは「保存」。
 * 保存はブログの発見を丸ごと置き換える (足す・消す・並べ替えもここで)。Server Action が revalidatePath するので、
 * 確認待ちでは保存すると次のブログに切り替わる (呼び出し側が key に assetId を渡して状態を作り直す)
 */
export function DiscoveryEditor({ blog, mode, canEdit }: { blog: EditorBlog; mode: "review" | "edit"; canEdit: boolean }) {
  const [items, setItems] = useState<Draft[]>(() =>
    blog.discoveries.map((d, i) => ({
      uid: i,
      no: d.no,
      heading: d.heading,
      excerpt: d.excerpt,
      isFood: d.isFood,
      ingredients: d.ingredients.join("、"),
      result: d.result ?? "",
      confidence: d.confidence,
    })),
  );
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const mountedAt = useRef(0);
  const nextUid = useRef(blog.discoveries.length);
  useEffect(() => {
    mountedAt.current = performance.now();
  }, []);

  const update = (i: number, patch: Partial<Draft>) =>
    setItems((prev) => prev.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  function save() {
    setMsg("保存中…");
    startTransition(async () => {
      const res = await saveBlogAction(
        blog.assetId,
        items.map((d) => ({
          heading: d.heading,
          excerpt: d.excerpt,
          isFood: d.isFood,
          ingredients: d.isFood ? splitNames(d.ingredients) : [],
          result: d.isFood && d.result.trim() ? d.result.trim() : null,
          confidence: d.confidence,
        })),
      );
      setMsg(res.ok ? (mode === "review" ? "確定しました" : "保存しました") : `エラー: ${res.error}`);
    });
  }

  // ⌘/Ctrl + Enter で確定・保存
  useEffect(() => {
    if (!canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
      if (e.repeat || e.isComposing || pending || performance.now() - mountedAt.current < KEY_GUARD_MS) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      save();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <section className="rounded-lg border border-slate-200 bg-white p-4 min-w-0">
        <div className="text-xs text-slate-500">{blog.date}</div>
        <h2 className="font-bold text-slate-900 mt-0.5">{blog.title}</h2>
        <div className="flex gap-3 mt-1 text-xs">
          {blog.url && (
            <a href={blog.url} target="_blank" rel="noreferrer" className="text-sky-700 hover:underline inline-flex items-center gap-1">
              公式ブログ <ExternalLink className="h-3 w-3" />
            </a>
          )}
          <a href={`/assets/${blog.assetId}`} className="text-sky-700 hover:underline">
            アセット
          </a>
        </div>
        <p className="text-[11px] text-slate-500 mt-3 mb-1">bot が抜き出した「今日の発見」の部分</p>
        <pre className="whitespace-pre-wrap text-sm text-slate-800 font-sans bg-slate-50 rounded-md p-3">
          {blog.excerpt || "(抜き出した本文がありません)"}
        </pre>
      </section>

      <section className="space-y-3 min-w-0">
        {items.map((d, i) => (
          <div key={d.uid} className="rounded-lg border border-slate-200 bg-white p-4 space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>
                {d.no !== null ? `No.${String(d.no).padStart(3, "0")}` : "新しい発見"}
                {items.length > 1 && ` (このブログの ${i + 1} 件目)`}
              </span>
              {canEdit && items.length > 1 && (
                <button
                  type="button"
                  onClick={() => setItems((prev) => prev.filter((_, j) => j !== i))}
                  className="inline-flex items-center gap-1 text-red-600 hover:underline"
                >
                  <Trash2 className="h-3 w-3" /> この発見を消す
                </button>
              )}
            </div>
            <div>
              <label className={labelCls} htmlFor={`h-${i}`}>見出し (一覧とサイトに出る)</label>
              <input id={`h-${i}`} className={inputCls} value={d.heading} disabled={!canEdit}
                onChange={(e) => update(i, { heading: e.target.value })} />
            </div>
            <div>
              <label className={labelCls} htmlFor={`x-${i}`}>本文の抜粋 (この発見の部分だけ)</label>
              <textarea id={`x-${i}`} rows={3} className={inputCls} value={d.excerpt} disabled={!canEdit}
                onChange={(e) => update(i, { excerpt: e.target.value })} />
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={d.isFood} disabled={!canEdit}
                onChange={(e) => update(i, { isFood: e.target.checked })} />
              食べ物の発見 (外すと材料・できあがりは保存しない)
            </label>
            {d.isFood && (
              <div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div>
                  <label className={labelCls} htmlFor={`i-${i}`}>材料 (「、」区切り。本人が書いたとおり、表記ゆれだけ揃える)</label>
                  <input id={`i-${i}`} className={inputCls} value={d.ingredients} disabled={!canEdit}
                    onChange={(e) => update(i, { ingredients: e.target.value })} />
                </div>
                <div>
                  <label className={labelCls} htmlFor={`r-${i}`}>できあがる味 (「〇〇になる」のときだけ)</label>
                  <input id={`r-${i}`} className={inputCls} value={d.result} disabled={!canEdit}
                    onChange={(e) => update(i, { result: e.target.value })} />
                </div>
              </div>
            )}
            <div>
              <span className={labelCls} id={`c-${d.uid}`}>確信度</span>
              <div className="flex gap-2" role="group" aria-labelledby={`c-${d.uid}`}>
                {(Object.keys(DISCOVERY_CONFIDENCE_LABELS) as Confidence[]).map((k) => (
                  <button key={k} type="button" aria-pressed={d.confidence === k} disabled={!canEdit}
                    onClick={() => update(i, { confidence: k })}
                    className={
                      "px-3 py-1 rounded-md border text-xs " +
                      (d.confidence === k
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50")
                    }>
                    {DISCOVERY_CONFIDENCE_LABELS[k]}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ))}

        {canEdit && (
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={save} disabled={pending}
              className="px-4 py-2 rounded-md bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50">
              {mode === "review" ? "確定して次へ" : "保存"}
              <span className="ml-2 text-[11px] opacity-70">⌘↵</span>
            </button>
            <button type="button" disabled={pending}
              onClick={() =>
                setItems((prev) => [
                  ...prev,
                  // 抜粋はブログの抜き出しを入れておき、この発見の部分だけに削ってもらう
                  { uid: nextUid.current++, no: null, heading: "", excerpt: blog.excerpt, isFood: true, ingredients: "", result: "", confidence: "certain" },
                ])
              }
              className="inline-flex items-center gap-1 px-3 py-2 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50">
              <Plus className="h-4 w-4" /> 発見を足す
            </button>
            {msg && <span className="text-sm text-slate-600" role="status">{msg}</span>}
          </div>
        )}
      </section>
    </div>
  );
}
