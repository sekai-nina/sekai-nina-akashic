"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, Loader2, Play, Scissors } from "lucide-react";
import { createMessageClipAction, deleteClipsAction, updateClipNoteAction } from "@/app/(main)/clips/actions";
import { setMaterialClipProgressAction } from "@/app/(main)/progress/material-actions";
import { MaterialProgressButton } from "@/app/(main)/progress/material-button";
import { ClipDialog, type ClipDraft } from "@/components/clip-dialog";
import type { TalkClip, TalkDay, TalkMessage } from "@/lib/domain/talk-day";
import { TALK_DAY_LABELS as L, cn } from "@/lib/utils";

/** 言及の前後を一度に開く件数 */
const THREAD_STEP = 3;

/** 本文の範囲選択。位置はサーバが本文から探す (`createClip`) ので文字列だけ持つ */
interface TextPick { assetId: string; text: string; top: number; left: number }

export function TalkDayBoard({ talk, editable }: { talk: TalkDay; editable: boolean }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [pick, setPick] = useState<TextPick | null>(null);
  const [dialog, setDialog] = useState<{ assetId: string; draft: ClipDraft } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // スマホではボタンに触れた時点で選択が外れることがある。押している間は消さない
  const pressingPick = useRef(false);

  useEffect(() => {
    if (!editable) return;
    const update = () => {
      if (pressingPick.current) return;
      const sel = window.getSelection();
      const holder = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-talk-text]");
      const from = sel && !sel.isCollapsed && sel.rangeCount ? holder(sel.anchorNode) : null;
      const text = sel?.toString().trim();
      if (!sel || !from || from !== holder(sel.focusNode) || !text) return setPick(null);
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setPick({ assetId: from.dataset.talkText!, text, top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 48)), left: rect.left + rect.width / 2 });
    };
    document.addEventListener("selectionchange", update);
    // スクロールするのは <main> で、scroll はバブルしないので capture で受ける
    window.addEventListener("scroll", update, { passive: true, capture: true });
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", update, { capture: true });
    };
  }, [editable]);

  const run = (task: () => Promise<{ ok: true } | { ok: false; error: string }>, onDone?: () => void) => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await task();
        if (!result.ok) return setError(result.error);
        // action の revalidate が今のページも描き直すので、refresh は要らない
        onDone?.();
      } catch { setError(L.failed); }
    });
  };

  const clipTogether = () => {
    // 時刻順で束ねる。選んだ順にはしない。開いた前後のメッセージも対象
    const all = [...talk.messages, ...Object.values(talk.threads).flatMap((t) => [...t.before, ...t.after])];
    const assetIds = [...new Map(all.filter((m) => selected.has(m.assetId)).map((m) => [m.assetId, m])).values()]
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((m) => m.assetId);
    run(() => createMessageClipAction({ assetIds, note }), () => {
      setSelected(new Set());
      setNote("");
    });
  };

  const renderRow = (message: TalkMessage) => (
    <MessageRow key={message.assetId} message={message} editable={editable} pending={pending}
      checked={selected.has(message.assetId)}
      onCheck={() => setSelected((prev) => {
        const next = new Set(prev);
        if (!next.delete(message.assetId)) next.add(message.assetId);
        return next;
      })}
      onClip={(onCreated) => run(async () => {
        const result = await createMessageClipAction({ assetIds: [message.assetId] });
        if (result.ok) onCreated(result.ids[0]);
        return result;
      })}
      onRemove={(clip) => run(() => deleteClipsAction(clip.itemIds))} />
  );

  return (
    <>
      {/* 長い一覧の上のほうで押しても見えるように、画面に貼り付ける */}
      {error && <p role="alert" className="sticky top-2 z-10 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <ol className="space-y-3 rounded-lg bg-slate-100 p-3 sm:p-4">
        {talk.messages.map((message) => {
          const thread = talk.threads[message.assetId];
          return thread
            ? <MentionThread key={message.assetId} message={message} thread={thread} renderRow={renderRow} />
            : renderRow(message);
        })}
        {!talk.messages.length && <li className="p-6 text-center text-sm text-slate-500">{L.empty}</li>}
      </ol>

      {selected.size > 0 && (
        <div className="sticky bottom-20 z-10 flex md:bottom-3 flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 shadow">
          <span className="text-sm font-medium">{selected.size} {L.selected}</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={L.notePlaceholder} aria-label={L.notePlaceholder}
            className="min-w-40 flex-1 rounded border border-slate-200 px-2 py-1.5 text-base sm:text-sm" />
          <button type="button" onClick={() => setSelected(new Set())} className="px-2 py-1.5 text-xs text-slate-500 hover:text-slate-800">{L.clearSelection}</button>
          <button type="button" disabled={pending} onClick={clipTogether}
            className="inline-flex items-center gap-1.5 rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-700 disabled:opacity-50">
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Scissors className="h-3.5 w-3.5" />}
            {L.clipTogether}
          </button>
        </div>
      )}

      {editable && <DayFooter talk={talk} />}

      {pick && !dialog && (
        <button type="button" style={{ top: pick.top, left: pick.left }}
          // 押した瞬間に選択が外れないようにする
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={() => { pressingPick.current = true; }}
          onPointerCancel={() => { pressingPick.current = false; }}
          onClick={() => {
            pressingPick.current = false;
            setDialog({ assetId: pick.assetId, draft: { excerpt: pick.text } });
          }}
          className="fixed z-20 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-slate-900 px-3 py-1.5 text-xs text-white shadow">
          <Scissors className="h-3.5 w-3.5" />{L.clipSelection}
        </button>
      )}
      {dialog && (
        <ClipDialog assetId={dialog.assetId} hasTexts open draft={dialog.draft}
          onOpenChange={(open) => { if (!open) setDialog(null); }} />
      )}
    </>
  );
}

/** 言及と、その場で開く同じ話し手の前後。ボタンの近くに出すので時系列の位置には混ぜない */
function MentionThread({ message, thread, renderRow }: {
  message: TalkMessage;
  thread: { before: TalkMessage[]; after: TalkMessage[] };
  renderRow: (message: TalkMessage) => ReactNode;
}) {
  const [before, setBefore] = useState(0);
  const [after, setAfter] = useState(0);
  const restBefore = thread.before.length - before;
  const restAfter = thread.after.length - after;
  const opened = before > 0 || after > 0;
  const more = "inline-flex items-center gap-1 text-xs text-indigo-700 hover:underline";
  return (
    <li>
      <ol className={cn("space-y-3", opened && "rounded-lg border-l-2 border-amber-300 bg-white/50 py-2 pl-2")}>
        {restBefore > 0 && (
          <li><button type="button" className={more} onClick={() => setBefore((n) => n + THREAD_STEP)}>
            <ChevronUp className="h-3.5 w-3.5" />{L.showBefore} ({restBefore})
          </button></li>
        )}
        {before > 0 && thread.before.slice(-before).map(renderRow)}
        {renderRow(message)}
        {thread.after.slice(0, after).map(renderRow)}
        {restAfter > 0 && (
          <li><button type="button" className={more} onClick={() => setAfter((n) => n + THREAD_STEP)}>
            <ChevronDown className="h-3.5 w-3.5" />{L.showAfter} ({restAfter})
          </button></li>
        )}
      </ol>
    </li>
  );
}

function MessageRow({ message, editable, pending, checked, onCheck, onClip, onRemove }: {
  message: TalkMessage; editable: boolean; pending: boolean; checked: boolean;
  onCheck: () => void; onClip: (onCreated: (clipId: string) => void) => void; onRemove: (clip: TalkClip) => void;
}) {
  const [playing, setPlaying] = useState(false);
  // ハサミで作った直後のクリップ。同じメッセージが前後の展開にも出るので、押した行だけで持つ
  const [freshClipId, setFreshClipId] = useState<string | null>(null);
  const label = `${message.speaker} ${message.time}`;
  return (
    <li className="flex items-start gap-2">
      {editable && (
        <label className="-ml-1 shrink-0 cursor-pointer p-1 pt-6">
          <input type="checkbox" checked={checked} onChange={onCheck} aria-label={`${label} ${L.selectMessage}`} className="h-4 w-4" />
        </label>
      )}
      <div className="min-w-0 max-w-[85%] sm:max-w-[75%]">
        <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span className="font-medium text-slate-700">{message.speaker}</span>
          <Link href={`/assets/${message.assetId}`} className="hover:underline">{message.time}</Link>
          {message.mention && <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-800">{L.mention}</span>}
        </p>
        <div className={cn("overflow-hidden rounded-2xl rounded-tl-sm border text-sm",
          checked ? "border-sky-400 ring-1 ring-sky-300" : "border-transparent", message.self ? "bg-sky-50" : "bg-white")}>
          {playing && message.playerUrl ? (
            <iframe src={message.playerUrl} title={label} allow="autoplay" allowFullScreen
              className={cn("w-full", message.kind === "audio" ? "h-24" : "aspect-video")} />
          ) : message.imageUrl ? (
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={message.imageUrl} alt={label} loading="lazy" className="max-h-80 w-full object-contain" />
              {message.playerUrl && (
                <button type="button" onClick={() => setPlaying(true)} aria-label={L.play}
                  className="absolute inset-0 flex items-center justify-center bg-black/20 text-white">
                  <Play className="h-10 w-10" />
                </button>
              )}
            </div>
          ) : message.playerUrl && (
            <button type="button" onClick={() => setPlaying(true)} className="inline-flex items-center gap-1.5 px-3 py-2 text-indigo-700">
              <Play className="h-4 w-4" />{L.play}
            </button>
          )}
          {message.body && <p data-talk-text={message.assetId} className="whitespace-pre-wrap break-words px-3 py-2">{message.body}</p>}
          {message.transcript && (
            <div className="border-t border-slate-200/70 px-3 py-2">
              <p className="text-[10px] text-slate-500">{L.transcript}</p>
              <p data-talk-text={message.assetId} className="whitespace-pre-wrap break-words text-slate-700">{message.transcript}</p>
            </div>
          )}
          {!message.body && !message.transcript && !message.imageUrl && !message.playerUrl && (
            <p className="px-3 py-2 text-slate-400">{L.noText}</p>
          )}
        </div>
        {message.clips.map((clip) => (
          <ClipRow key={clip.id} clip={clip} editable={editable} pending={pending} fresh={clip.id === freshClipId} onOpened={() => setFreshClipId(null)} onRemove={() => onRemove(clip)} />
        ))}
        {message.dossiers.length > 0 && (
          <p className="mt-1 text-xs text-slate-500">
            {L.usedIn}: {message.dossiers.map((d, i) => (
              <span key={d.id}>{i > 0 && "、"}<Link className="text-indigo-700 hover:underline" href={`/dossiers/${d.id}`}>{d.title}</Link></span>
            ))}
          </p>
        )}
      </div>
      {editable && (
        <button type="button" disabled={pending} onClick={() => onClip(setFreshClipId)} aria-label={`${label} ${L.clip}`} title={L.clip}
          className="mt-5 shrink-0 rounded-full border border-sky-300 bg-white p-2 text-sky-700 hover:bg-sky-50 disabled:opacity-50">
          <Scissors className="h-4 w-4" />
        </button>
      )}
    </li>
  );
}

function ClipRow({ clip, editable, pending, fresh, onOpened, onRemove }: {
  clip: TalkClip; editable: boolean; pending: boolean; fresh: boolean; onOpened: () => void; onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(clip.note);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  // 行が先に描かれることも、印が先に付くこともあるので、初期値ではなく effect で開く
  useEffect(() => {
    if (!fresh || !editable) return;
    setEditing(true);
    onOpened();
  }, [fresh, editable, onOpened]);
  const save = () => {
    setError(null);
    startSave(async () => {
      try {
        const result = await updateClipNoteAction(clip.noteItemId, draft);
        if (!result.ok) return setError(result.error);
        setEditing(false);
      } catch { setError(L.failed); }
    });
  };
  return (
    <div className="mt-1 rounded border border-sky-200 bg-white/70 px-2 py-1 text-xs text-slate-700">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 font-medium text-sky-700"><Scissors className="h-3 w-3" />{L.clipped}</span>
        {clip.itemIds.length > 1 && <span className="text-slate-500">{L.grouped} ({clip.itemIds.length})</span>}
        {editable && !editing && (
          <button type="button" onClick={() => { setDraft(clip.note); setEditing(true); }} className="text-slate-500 hover:text-slate-800">{L.addNote}</button>
        )}
        {editable && <button type="button" disabled={pending} className="ml-auto px-1 py-0.5 text-slate-500 hover:text-red-700 disabled:opacity-50"
          onClick={() => { if ((clip.itemIds.length === 1 && !clip.note) || window.confirm(L.confirmRemove)) onRemove(); }}>{L.remove}</button>}
      </div>
      {clip.excerpt && <p className="mt-0.5 line-clamp-2 text-slate-500">{clip.excerpt}</p>}
      {editing ? (
        <div className="mt-1 flex items-center gap-2">
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={L.notePlaceholder}
            className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1 text-base sm:text-xs" />
          <button type="button" disabled={saving} onClick={save} className="text-sky-700 disabled:opacity-50">{L.saveNote}</button>
          <button type="button" onClick={() => setEditing(false)} className="text-slate-500">{L.cancel}</button>
        </div>
      ) : clip.note && <p className="mt-0.5 whitespace-pre-wrap">{clip.note}</p>}
      {error && <p role="alert" className="mt-0.5 text-red-700">{error}</p>}
    </div>
  );
}

function DayFooter({ talk }: { talk: TalkDay }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const nextHref = talk.nextUnfinishedDay && `/progress/materials/talk/${talk.nextUnfinishedDay}${talk.scope === "all" ? "?scope=all" : ""}`;
  const finish = () => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await setMaterialClipProgressAction("talk", talk.day, "done", true);
        if (!result.ok) return setError(result.error);
        if (nextHref) router.push(nextHref);
      } catch { setError(L.failed); }
    });
  };
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 pt-1">
      {error && <span role="alert" className="text-sm text-red-700">{error}</span>}
      {talk.done ? (
        <>
          <MaterialProgressButton sourceKey="talk" itemKey={talk.day} value={false} />
          {nextHref && <Link href={nextHref} className="text-sm text-indigo-700 hover:underline">{L.goNext} →</Link>}
        </>
      ) : (
        <button type="button" disabled={pending} onClick={finish}
          className="rounded bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-700 disabled:opacity-50">
          {nextHref ? L.finishAndNext : L.finishOnly}
        </button>
      )}
    </div>
  );
}
