"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
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
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [pick, setPick] = useState<TextPick | null>(null);
  const [dialog, setDialog] = useState<{ assetId: string; draft: ClipDraft } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!editable) return;
    const update = () => {
      const sel = window.getSelection();
      const holder = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-talk-text]");
      const from = sel && !sel.isCollapsed && sel.rangeCount ? holder(sel.anchorNode) : null;
      const text = sel?.toString().trim();
      if (!sel || !from || from !== holder(sel.focusNode) || !text) return setPick(null);
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setPick({ assetId: from.dataset.talkText!, text, top: rect.bottom + 8, left: rect.left + rect.width / 2 });
    };
    document.addEventListener("selectionchange", update);
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", update);
    };
  }, [editable]);

  const run = (task: () => Promise<{ ok: true } | { ok: false; error: string }>, onDone?: () => void) => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await task();
        if (!result.ok) return setError(result.error);
        onDone?.();
        router.refresh();
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
      onClip={() => run(() => createMessageClipAction({ assetIds: [message.assetId] }))}
      onRemove={(clip) => run(() => deleteClipsAction(clip.itemIds))} />
  );

  return (
    <>
      <ol className="space-y-3 rounded-lg bg-slate-100 p-3 sm:p-4">
        {talk.messages.map((message) => {
          const thread = talk.threads[message.assetId];
          return thread
            ? <MentionThread key={message.assetId} message={message} thread={thread} renderRow={renderRow} />
            : renderRow(message);
        })}
        {!talk.messages.length && <li className="p-6 text-center text-sm text-slate-500">{L.empty}</li>}
      </ol>

      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

      {selected.size > 0 && (
        <div className="sticky bottom-2 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 shadow">
          <span className="text-sm font-medium">{selected.size} {L.selected}</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={L.notePlaceholder} aria-label={L.notePlaceholder}
            className="min-w-40 flex-1 rounded border border-slate-200 px-2 py-1.5 text-sm" />
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
          onClick={() => setDialog({ assetId: pick.assetId, draft: { excerpt: pick.text } })}
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
  onCheck: () => void; onClip: () => void; onRemove: (clip: TalkClip) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const self = message.speaker === "坂井新奈";
  return (
    <li className="flex items-start gap-2">
      {editable && (
        <input type="checkbox" checked={checked} onChange={onCheck} aria-label={`${message.time} ${L.selectMessage}`} className="mt-6 h-4 w-4 shrink-0" />
      )}
      <div className="min-w-0 max-w-[85%] sm:max-w-[75%]">
        <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span className="font-medium text-slate-700">{message.speaker}</span>
          <Link href={`/assets/${message.assetId}`} className="hover:underline">{message.time}</Link>
          {message.mention && <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-800">{L.mention}</span>}
        </p>
        <div className={cn("overflow-hidden rounded-2xl rounded-tl-sm border text-sm",
          checked ? "border-sky-400 ring-1 ring-sky-300" : "border-transparent", self ? "bg-sky-50" : "bg-white")}>
          {playing && message.playerUrl ? (
            <iframe src={message.playerUrl} title={message.time} allow="autoplay" allowFullScreen
              className={cn("w-full", message.kind === "audio" ? "h-24" : "aspect-video")} />
          ) : message.imageUrl ? (
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={message.imageUrl} alt="" loading="lazy" className="max-h-80 w-full object-contain" />
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
          <ClipRow key={clip.id} clip={clip} editable={editable} pending={pending} onRemove={() => onRemove(clip)} />
        ))}
        {message.dossiers.length > 0 && (
          <p className="mt-1 text-xs text-slate-500">
            {L.usedIn}: {message.dossiers.map((d, i) => (
              <span key={d.id}>{i > 0 && "、"}<Link className="text-indigo-700 hover:underline" href={`/dossiers/${d.id}`}>{d.title}</Link></span>
            ))}
          </p>
        )}
      </div>
      {editable && !message.wholeClipped && (
        <button type="button" disabled={pending} onClick={onClip} aria-label={`${message.time} ${L.clip}`} title={L.clip}
          className="mt-6 shrink-0 rounded-full border border-sky-300 bg-white p-1.5 text-sky-700 hover:bg-sky-50 disabled:opacity-50">
          <Scissors className="h-4 w-4" />
        </button>
      )}
    </li>
  );
}

function ClipRow({ clip, editable, pending, onRemove }: { clip: TalkClip; editable: boolean; pending: boolean; onRemove: () => void }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(clip.note);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const save = () => {
    setError(null);
    startSave(async () => {
      try {
        const result = await updateClipNoteAction(clip.noteItemId, draft);
        if (!result.ok) return setError(result.error);
        setEditing(false);
        router.refresh();
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
        {editable && <button type="button" disabled={pending} onClick={onRemove} className="text-slate-500 hover:text-red-700 disabled:opacity-50">{L.remove}</button>}
      </div>
      {clip.excerpt && <p className="mt-0.5 line-clamp-2 text-slate-500">{clip.excerpt}</p>}
      {editing ? (
        <div className="mt-1 flex items-center gap-2">
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={L.notePlaceholder}
            className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1" />
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
  const nextHref = talk.nextUnfinishedDay && `/progress/materials/talk/${talk.nextUnfinishedDay}`;
  const finish = () => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await setMaterialClipProgressAction("talk", talk.day, "done", true);
        if (!result.ok) return setError(result.error);
        if (nextHref) router.push(nextHref);
        else router.refresh();
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
