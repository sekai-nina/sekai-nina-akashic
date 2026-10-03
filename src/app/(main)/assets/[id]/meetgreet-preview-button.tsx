"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Shirt } from "lucide-react";
import { setPreviewsFromAssetAction } from "../../meetgreets/actions";
import { formatJpDate, MEETGREET_FORMAT_LABELS } from "@/lib/utils";
import type { PreviewTarget } from "@/lib/domain/meetgreet-preview";

/**
 * アセットページのヘッダ操作 (#203)。ブログ / トークで次回以降のミーグリのコーデ予告を
 * 見つけたら、開催予定の回ごとに文面を書く。書いた回にはこのアセットが出典として入る。
 * 開催予定の回は先に /meetgreets で作っておく。
 */
export function MeetGreetPreviewButton({ assetId, targets }: { assetId: string; targets: PreviewTarget[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(targets.map((t) => [t.id, t.linked ? t.outfit : ""]))
  );
  const [msg, setMsg] = useState<string | null>(null);
  const linkedCount = targets.filter((t) => t.linked).length;

  function save() {
    // このアセットが出典の回 (消すと外す) と、文面を書いた回だけ送る
    const entries = targets
      .filter((t) => t.linked || values[t.id]?.trim())
      .map((t) => ({ meetGreetId: t.id, outfit: values[t.id] ?? "" }));
    if (entries.length === 0) {
      setMsg("予告を書いた回がありません");
      return;
    }
    startTransition(async () => {
      const res = await setPreviewsFromAssetAction(assetId, entries);
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setMsg(res.updated > 0 ? `${res.updated} 回分を保存しました` : "変更はありません");
      router.refresh();
    });
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 border border-slate-300 text-slate-700 px-3 py-1.5 rounded text-sm hover:bg-slate-50 transition-colors"
      >
        <Shirt className={`h-4 w-4 ${linkedCount > 0 ? "text-green-600" : ""}`} />
        ミーグリの予告{linkedCount > 0 && `: ${linkedCount} 回`}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-[26rem] max-w-[90vw] rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
          <p className="text-xs text-slate-500">
            このアセットで予告されたコーデを、回ごとに書いてください。書いた回の出典にこのアセットが入ります。空にするとこのアセットを出典から外します (他の出典が無ければ予告も消えます)。
          </p>
          {targets.length === 0 ? (
            <p className="mt-2 text-xs text-amber-700">
              開催予定の回がありません。先に <Link href="/meetgreets/new" className="underline">ミーグリを作成</Link> してください。
            </p>
          ) : (
            <ul className="mt-2 space-y-2 max-h-80 overflow-y-auto">
              {targets.map((t) => (
                <li key={t.id}>
                  <label className="block text-xs text-slate-600">
                    {formatJpDate(t.date)} {t.label}
                    {MEETGREET_FORMAT_LABELS[t.format]}ミーグリ
                    {!t.linked && t.outfit && <span className="text-slate-400">（別の出典で入力済み: {t.outfit}）</span>}
                  </label>
                  <textarea
                    rows={2}
                    className="mt-0.5 w-full px-2 py-1 rounded-md border border-slate-200 text-sm outline-none focus:border-slate-400"
                    value={values[t.id] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [t.id]: e.target.value }))}
                    placeholder={t.linked ? "" : "予告が無ければ空のまま"}
                  />
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={pending || targets.length === 0}
              className="h-8 px-3 rounded-md bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50"
            >
              保存
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-8 px-3 rounded-md border border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
            >
              閉じる
            </button>
            {msg && <span className="text-xs text-slate-600">{msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
