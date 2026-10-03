"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { setMeetGreetPreviewAction } from "../actions";

const inputCls =
  "w-full px-2 py-1 rounded-md border border-slate-200 bg-white text-sm text-slate-900 outline-none focus:border-slate-400";

interface Source {
  assetId: string;
  title: string;
  date: string | null;
}

/**
 * 予告コーデ (#203)。本人がブログ / トークで公言した次回のコーデを書く。
 * 開催日が今日 (JST) 以降なら、次の公開サイトのビルドで「次回以降のミーグリ」に出る。
 */
export function PreviewForm({
  id,
  outfit,
  sources,
  upcoming,
}: {
  id: string;
  outfit: string;
  sources: Source[];
  /** 開催日が今日 (JST) 以降か。過去の回は予告と実際を比べる記録として残すだけ */
  upcoming: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [o, setO] = useState(outfit);
  const [s, setS] = useState(sources.map((x) => x.assetId).join("\n"));
  const [msg, setMsg] = useState<string | null>(null);

  function save() {
    startTransition(async () => {
      const res = await setMeetGreetPreviewAction(id, { outfit: o, sources: s });
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setMsg(null);
      setEditing(false);
      router.refresh();
    });
  }

  return (
    <section className="mt-3 rounded-lg border border-slate-200 bg-white p-3 text-sm">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-semibold text-slate-500">予告コーデ</h2>
        {outfit && upcoming && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">公開サイトに出ます</span>
        )}
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="ml-auto inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-700"
          >
            <Pencil size={12} /> 編集
          </button>
        )}
      </div>

      {!editing ? (
        <>
          <p className="mt-1 text-slate-800 whitespace-pre-wrap">
            {outfit || <span className="text-slate-400">未入力</span>}
          </p>
          {sources.length > 0 && (
            <p className="mt-1 text-xs text-slate-500">
              出典:{" "}
              {sources.map((x, i) => (
                <span key={x.assetId}>
                  {i > 0 && "・"}
                  <Link href={`/assets/${x.assetId}`} className="hover:underline">
                    {x.title}
                  </Link>
                </span>
              ))}
            </p>
          )}
        </>
      ) : (
        <div className="mt-2 space-y-2">
          <textarea
            className={inputCls}
            rows={2}
            value={o}
            onChange={(e) => setO(e.target.value)}
            placeholder="例: 新緑の季節にちなんだ、優しい緑のコーデ"
            aria-label="予告コーデ"
          />
          <textarea
            className={inputCls + " font-mono text-xs"}
            rows={2}
            value={s}
            onChange={(e) => setS(e.target.value)}
            placeholder="出典アセットの ID か URL (1 行に 1 つ)"
            aria-label="出典アセット"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className="h-8 px-3 rounded-md bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50"
            >
              保存
            </button>
            <button
              type="button"
              onClick={() => {
                // 取り消した入力を次に開いたときに残さない
                setO(outfit);
                setS(sources.map((x) => x.assetId).join("\n"));
                setMsg(null);
                setEditing(false);
              }}
              className="h-8 px-3 rounded-md border border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
            >
              取消
            </button>
          </div>
          <p className="text-xs text-slate-400">
            開催日が今日以降で予告が空でなければ、次の公開サイトのビルドで「次回以降のミーグリ」に出ます。
            ブログ / トークのアセットページからも、開催予定の回にまとめて書けます。
            出典欄には自分に見えるものだけが出ます。見えない出典は保存しても残ります。
          </p>
          {msg && <p className="text-xs text-red-600">{msg}</p>}
        </div>
      )}
    </section>
  );
}
