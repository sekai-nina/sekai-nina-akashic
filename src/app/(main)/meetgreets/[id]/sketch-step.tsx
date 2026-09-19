"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { Check, Sparkles } from "lucide-react";
import type { SketchCandidate, SketchSourceAsset } from "@/lib/meetgreet/types";
import { maxReferencePhotos } from "@/lib/meetgreet/config";
import { generateSketchAction, selectSketchAction, updateMeetGreetAction } from "../actions";

interface Props {
  meetGreetId: string;
  sources: SketchSourceAsset[];
  candidates: SketchCandidate[];
  selectedKey: string | null;
  extraPrompt: string;
}

const textareaCls =
  "w-full px-3 py-2 rounded-md border border-slate-200 bg-white text-sm text-slate-900 outline-none focus:border-slate-400";

/**
 * スケッチの生成。ドシエの画像から参照を選び、候補を 2 枚作って 1 枚を確定する。
 * 気に入らなければ候補を 1 枚選んで修正指示を書き、それを元に作り直す。
 */
export function SketchStep({ meetGreetId, sources, candidates, selectedKey, extraPrompt }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState(extraPrompt);
  const [revisionOf, setRevisionOf] = useState<string | null>(null);
  const [revisionNote, setRevisionNote] = useState("");

  // 作り直しでは直す候補で 1 枚使うので、写真の上限がその分下がる
  const limit = maxReferencePhotos(!!revisionOf);
  const sourceIds = useMemo(() => new Set(sources.map((a) => a.id)), [sources]);
  // ドシエから外された画像が選ばれたままにならないようにする
  useEffect(() => {
    setPicked((s) => {
      const next = new Set([...s].filter((id) => sourceIds.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [sourceIds]);
  const overLimit = picked.size > limit;

  function togglePhoto(id: string) {
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function generate() {
    if (picked.size === 0) {
      setMsg("参照にする写真を選んでください");
      return;
    }
    if (overLimit) {
      setMsg(
        revisionOf
          ? `作り直しでは直す候補で 1 枚使うので、写真は ${limit} 枚までです`
          : `参照にできる写真は ${limit} 枚までです`
      );
      return;
    }
    setMsg("生成中… 1 分ほどかかります");
    startTransition(async () => {
      // 追加指示は生成の前に保存する。**失敗したら生成しない**
      // (サーバーは保存済みの指示を読むので、古い内容で 1 分かけて作ってしまう)
      if (extra !== extraPrompt) {
        const saved = await updateMeetGreetAction(meetGreetId, { extraSketchPrompt: extra }).catch(
          (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : "保存に失敗しました" })
        );
        if (!saved.ok) {
          setMsg(`追加指示を保存できませんでした: ${saved.error}`);
          return;
        }
      }
      const res = await generateSketchAction(meetGreetId, {
        assetIds: [...picked],
        ...(revisionOf ? { revisionOf, revisionNote } : {}),
      }).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "通信に失敗しました",
      }));
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setMsg(`${res.candidates.length} 枚できました`);
      setRevisionOf(null);
      setRevisionNote("");
      router.refresh();
    });
  }

  function select(key: string) {
    startTransition(async () => {
      const res = await selectSketchAction(meetGreetId, key).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "通信に失敗しました",
      }));
      setMsg(res.ok ? "確定しました (記事のサムネになります)" : `エラー: ${res.error}`);
      if (res.ok) router.refresh();
    });
  }

  if (sources.length === 0) {
    return (
      <p className="text-xs text-slate-500">
        ドシエに画像がありません。先に素材を反映してから生成してください。
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="text-xs font-medium text-slate-600">
            参照にする写真 ({picked.size} / 最大 {limit})
          </span>
          <span className="text-[11px] text-slate-400">その日の服装・髪型が分かるものを選ぶ</span>
        </div>
        <ul className="grid grid-cols-3 sm:grid-cols-5 gap-2" role="group" aria-label="参照にする写真">
          {sources.map((a) => {
            const on = picked.has(a.id);
            return (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => togglePhoto(a.id)}
                  aria-pressed={on}
                  title={a.title}
                  className={
                    "block w-full rounded-md overflow-hidden border-2 transition-colors " +
                    (on ? "border-slate-900" : "border-transparent hover:border-slate-300")
                  }
                >
                  {a.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.thumbnailUrl} alt={a.title} className="w-full h-20 object-cover bg-slate-100" />
                  ) : (
                    <span className="flex h-20 items-center justify-center bg-slate-100 text-[10px] text-slate-400 px-1 text-center">
                      {a.title}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1.5" htmlFor="mg-extra-prompt">
          この回の追加指示 (任意。どの髪型を中央にするか、配置の希望など)
        </label>
        <textarea
          id="mg-extra-prompt"
          className={textareaCls}
          rows={2}
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          placeholder="例: 中央はハーフアップ、左右に低めツインテールと帽子ありを置いてほしい"
        />
      </div>

      {revisionOf && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs text-amber-800 mb-1.5">
            選んだ候補をもとに作り直します。直したいところを書いてください。
          </p>
          <textarea
            className={textareaCls}
            rows={2}
            value={revisionNote}
            onChange={(e) => setRevisionNote(e.target.value)}
            placeholder="例: 袖のふくらみをもっと大きく、中央の髪をもう少し明るく"
            aria-label="修正指示"
          />
          <button
            type="button"
            onClick={() => setRevisionOf(null)}
            className="mt-1.5 text-[11px] text-amber-700 hover:underline"
          >
            作り直しをやめる
          </button>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={generate}
          disabled={pending || picked.size === 0 || overLimit}
          className="inline-flex items-center gap-1 h-9 px-4 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800 disabled:opacity-50"
        >
          <Sparkles size={14} /> {revisionOf ? "作り直す" : "候補を生成"}
        </button>
        {msg && <span className="text-xs text-slate-500">{msg}</span>}
      </div>

      {candidates.length > 0 && (
        <div>
          <span className="block text-xs font-medium text-slate-600 mb-1.5">
            候補（新しい順）
          </span>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {candidates.map((c, i) => {
              const isSelected = c.key === selectedKey;
              return (
                <li
                  key={c.key}
                  className={
                    "rounded-md border overflow-hidden " +
                    (isSelected ? "border-emerald-500 ring-1 ring-emerald-200" : "border-slate-200")
                  }
                >
                  <a href={c.url} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={c.url}
                      alt={`スケッチ候補 ${i + 1}${isSelected ? "（確定済み）" : ""}`}
                      className="w-full bg-white"
                    />
                  </a>
                  <div className="flex items-center gap-2 px-2 py-1.5 border-t border-slate-100">
                    {isSelected ? (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                        <Check size={12} /> 確定済み
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => select(c.key)}
                        disabled={pending}
                        className="text-xs text-slate-700 hover:text-slate-900 underline underline-offset-2 disabled:opacity-50"
                      >
                        これにする
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setRevisionOf(c.key);
                        setMsg(null);
                      }}
                      disabled={pending}
                      className="ml-auto text-xs text-slate-500 hover:text-slate-800 disabled:opacity-50"
                    >
                      これを直す
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
