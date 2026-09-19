"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Wand2 } from "lucide-react";
import type { BlogExcerptProposals } from "@/lib/meetgreet/types";
import { applyExcerptsAction, proposeExcerptsAction } from "../actions";

/**
 * 「本人の感想」の抜粋提案。ボタンを押すと LLM がブログ本文から候補を出し、
 * 選んだものをドシエに抜粋付きアイテムとして入れる。
 * 細かい範囲の調整はドシエ側の範囲選択 UI で行う。
 */
export function ExcerptStep({ meetGreetId }: { meetGreetId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [blogs, setBlogs] = useState<BlogExcerptProposals[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const keyOf = (assetId: string, start: number, end: number) => `${assetId}:${start}:${end}`;

  function propose() {
    setMsg("ブログ本文を読んでいます…");
    startTransition(async () => {
      // 長く待たせる処理なので、通信ごと落ちたときに固まったままにしない
      const res = await proposeExcerptsAction(meetGreetId).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "通信に失敗しました",
      }));
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setBlogs(res.blogs);
      const total = res.blogs.reduce((n, b) => n + b.proposals.length, 0);
      // 提案は既定で全部チェック (人は外すだけで済む)
      setPicked(
        new Set(
          res.blogs.flatMap((b) => b.proposals.map((p) => keyOf(b.assetId, p.start, p.end)))
        )
      );
      setMsg(
        total === 0
          ? res.blogs.length === 0
            ? "ドシエに本人のブログ本文がありません（先に素材を反映してください）"
            : "このミーグリについて書かれた部分は見つかりませんでした"
          : `${total} 件の候補が見つかりました`
      );
    });
  }

  function apply() {
    if (!blogs) return;
    const inputs = blogs.flatMap((b) =>
      b.proposals
        .filter((p) => picked.has(keyOf(b.assetId, p.start, p.end)))
        .map((p) => ({ assetId: b.assetId, start: p.start, end: p.end }))
    );
    if (inputs.length === 0) {
      setMsg("チェックされた抜粋がありません");
      return;
    }
    setMsg("反映中…");
    startTransition(async () => {
      const res = await applyExcerptsAction(meetGreetId, inputs).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "通信に失敗しました",
      }));
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setMsg(
        `${res.added} 件をドシエに入れました${res.skipped > 0 ? ` (${res.skipped} 件は既にある範囲などで見送り)` : ""}`
      );
      // 入ったぶんだけチェックを外す。見送られたものは選び直せるよう候補は残す
      setPicked(new Set());
      if (res.skipped === 0) setBlogs(null);
      router.refresh();
    });
  }

  const total = blogs?.reduce((n, b) => n + b.proposals.length, 0) ?? 0;

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={propose}
          disabled={pending}
          className="inline-flex items-center gap-1 h-8 px-3 rounded-md border border-slate-200 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          <Wand2 size={12} /> 本人の感想の抜粋を提案
        </button>
        {msg && <span className="text-xs text-slate-500">{msg}</span>}
      </div>

      {blogs && total > 0 && (
        <div className="mt-3 space-y-3">
          {blogs
            .filter((b) => b.proposals.length > 0)
            .map((b) => (
              <div key={b.assetId} className="rounded-md border border-slate-200">
                <div className="px-3 py-2 bg-slate-50 text-sm font-medium text-slate-800 truncate">
                  {b.url ? (
                    <a href={b.url} target="_blank" rel="noreferrer" className="hover:underline">
                      {b.title}
                    </a>
                  ) : (
                    b.title
                  )}
                </div>
                <ul className="divide-y divide-slate-100">
                  {b.proposals.map((p) => {
                    const k = keyOf(b.assetId, p.start, p.end);
                    return (
                      <li key={k}>
                        <label className="flex gap-3 px-3 py-2 cursor-pointer">
                          <input
                            type="checkbox"
                            className="mt-1 shrink-0"
                            checked={picked.has(k)}
                            onChange={() =>
                              setPicked((s) => {
                                const next = new Set(s);
                                if (next.has(k)) next.delete(k);
                                else next.add(k);
                                return next;
                              })
                            }
                          />
                          <span className="min-w-0">
                            <span className="block text-sm text-slate-800 whitespace-pre-wrap">{p.text}</span>
                            {p.reason && (
                              <span className="block text-[11px] text-slate-400 mt-1">{p.reason}</span>
                            )}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={apply}
              disabled={pending || picked.size === 0}
              className="h-8 px-3 rounded-md bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50"
            >
              ドシエに入れる ({picked.size})
            </button>
            <span className="text-[11px] text-slate-400">
              入れたあと、引用文はドシエの画面で直せます
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
