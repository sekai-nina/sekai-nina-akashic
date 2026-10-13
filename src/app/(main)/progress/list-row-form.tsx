"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import type { AddListRowResult, ShowVideo } from "@/lib/domain/show-progress";
import { SHOWS, type ShowKey } from "@/lib/progress/shows";
import { cn } from "@/lib/utils";
import { addShowListRowAction } from "./show-actions";

const PUSH_MESSAGES = {
  pushed: "公開しました",
  pending_edits: "記事に未 push の編集が残っていたので push していません（/articles/push から）",
  not_configured: "GitHub が未設定なので push していません",
  skipped: "push 待ちです（/articles/push から）",
  conflict: "GitHub 側の記事と衝突したので push していません（/articles/push で確認）",
  blocked: "非公開の出典があるので push していません（/articles/push で確認）",
  db_error: "push はしましたが DB の更新に失敗しました（/articles/push で確認）",
  failed: "push に失敗しました（行は入っています。/articles/push からやり直してください）",
} satisfies Record<AddListRowResult["push"], string>;

/** 回の動画 1 本ぶんの行を出演一覧に足すフォーム (Discord の 📤 の代わり) */
export function ListRowForm({
  showKey,
  videos,
  canPublish,
  onDone,
  onCancel,
}: {
  showKey: ShowKey;
  videos: ShowVideo[];
  canPublish: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const show = SHOWS[showKey];
  const [assetId, setAssetId] = useState(videos[0]?.assetId ?? "");
  const [cells, setCells] = useState<Record<string, string>>(() =>
    Object.fromEntries(show.listCells.map((c) => [c.name, c.kind === "mark" ? "—" : ""]))
  );
  const titleOf = (id: string) => videos.find((v) => v.assetId === id)?.listTitle ?? "";
  const [title, setTitle] = useState(() => titleOf(videos[0]?.assetId ?? ""));
  const [publish, setPublish] = useState(canPublish);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // 足したあとは閉じるまで押せなくする (番外編は枝番が進むので二重に足せてしまう)
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function submit() {
    setMessage(null);
    startTransition(async () => {
      const res = await addShowListRowAction(showKey, assetId, { ...cells, タイトル: title }, publish);
      if (!res.ok) {
        setMessage({ ok: false, text: res.error });
        return;
      }
      setDone(true);
      setMessage({ ok: true, text: `#${res.label} を「${res.articleTitle}」に足しました。${PUSH_MESSAGES[res.push]}` });
      // 成功の文言を読めるよう少し待ってから閉じて描き直す
      timer.current = setTimeout(onDone, 2000);
    });
  }

  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-white p-3 text-xs text-slate-700 space-y-2">
      {videos.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium w-12 shrink-0">動画</span>
          {videos.map((v) => (
            <label key={v.assetId} className="inline-flex items-center gap-1">
              <input type="radio" name={`video-${videos[0].assetId}`} checked={assetId === v.assetId}
                onChange={() => {
                  setAssetId(v.assetId);
                  setTitle(titleOf(v.assetId));
                }}
              />
              {v.extra ? (show.extraLabel ?? "番外編") : "本編"}
            </label>
          ))}
        </div>
      )}
      <label className="flex items-center gap-2">
        <span className="font-medium w-12 shrink-0">タイトル</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className="flex-1 min-w-0 h-7 rounded-md border border-slate-200 px-2" />
      </label>
      {show.listCells.map((c) =>
        c.kind === "mark" ? (
          <div key={c.name} className="flex items-center gap-2">
            <span className="font-medium w-12 shrink-0">{c.name}</span>
            {["○", "—"].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setCells((s) => ({ ...s, [c.name]: m }))}
                className={cn(
                  "h-6 w-8 rounded-md border",
                  cells[c.name] === m ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 hover:bg-slate-50"
                )}
              >
                {m}
              </button>
            ))}
          </div>
        ) : (
          <label key={c.name} className="flex items-start gap-2">
            <span className="font-medium w-12 shrink-0 pt-1">{c.name}</span>
            <textarea
              value={cells[c.name] ?? ""}
              onChange={(e) => setCells((s) => ({ ...s, [c.name]: e.target.value }))}
              rows={2}
              placeholder={c.name === "補足" ? "改行は <br> になる" : ""}
              className="flex-1 min-w-0 rounded-md border border-slate-200 px-2 py-1"
            />
          </label>
        )
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {canPublish && (
          <label className="inline-flex items-center gap-1 text-slate-600">
            <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} />
            すぐ公開 (push)
          </label>
        )}
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={onCancel} disabled={pending} className="h-7 px-3 rounded-md border border-slate-200 hover:bg-slate-50">
            やめる
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending || done || !assetId}
            className="inline-flex items-center gap-1 h-7 px-3 rounded-md border border-slate-900 bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            足す
          </button>
        </div>
      </div>
      {message && <p className={message.ok ? "text-emerald-700" : "text-red-600"}>{message.text}</p>}
    </div>
  );
}
