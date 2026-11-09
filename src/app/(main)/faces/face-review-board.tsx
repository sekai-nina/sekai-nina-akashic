"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FaceDecision } from "@/lib/domain/face-review";
import { submitFaceReview } from "./actions";

type Face = {
  id: string;
  assetId: string;
  assetTitle: string;
  thumbnailUrl: string | null;
  bbox: [number, number, number, number];
  similarity: number | null;
  predictedEntityId: string | null;
  predictedName: string;
};
type Member = { id: string; name: string; generation: number };

/** 1 顔分の判断。confirm = 推定どおり (本人) / reject = 推定のメンバーではない / nonmember = メンバー以外・顔ではない */
type Choice = { action: "confirm" } | { action: "reject" } | { action: "nonmember" } | { action: "other"; entityId: string };

const TILE = 112;

/**
 * 顔の一覧 (#409)。キーボードだけで回せる。
 * - 確認待ち (pending): ほとんどが本人ではないので、何も選ばなければ「推定のメンバーではない」。本人だけを選ぶ
 * - 自動で付いた顔 (auto): ほとんどが本人なので、何も選ばなければ「推定どおり」。違う顔だけを選ぶ
 */
export function FaceReviewBoard({
  faces,
  members,
  mode,
  canEdit,
  nav,
}: {
  faces: Face[];
  members: Member[];
  mode: "pending" | "auto";
  canEdit: boolean;
  /** [ ] で前後のメンバー、t で確認待ち ⇄ 自動で付いた顔 */
  nav: { prevMember: string | null; nextMember: string | null; otherMode: string };
}) {
  const router = useRouter();
  const defaultChoice: Choice = useMemo(() => (mode === "pending" ? { action: "reject" } : { action: "confirm" }), [mode]);
  const toggledChoice: Choice = mode === "pending" ? { action: "confirm" } : { action: "reject" };
  const [choices, setChoices] = useState<Map<string, Choice>>(new Map());
  const [cursor, setCursor] = useState(0);
  const [picker, setPicker] = useState<string | null>(null); // 別のメンバーを選んでいる顔の id
  const [saving, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(6);

  const choiceOf = useCallback((id: string): Choice => choices.get(id) ?? defaultChoice, [choices, defaultChoice]);
  const setChoice = (id: string, c: Choice | null) =>
    setChoices((prev) => {
      const next = new Map(prev);
      if (c === null) next.delete(id);
      else next.set(id, c);
      return next;
    });
  const toggle = (id: string) => {
    if (!canEdit) return;
    setChoice(id, choices.has(id) ? null : toggledChoice);
  };

  // 列の数 (上下の移動に使う)
  useEffect(() => {
    const measure = () => {
      const el = gridRef.current;
      if (el) setCols(Math.max(1, Math.floor((el.clientWidth + 8) / (TILE + 8))));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    gridRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const counts = useMemo(() => {
    let confirm = 0;
    for (const f of faces) if (choiceOf(f.id).action === "confirm") confirm++;
    return { confirm, other: faces.length - confirm };
  }, [faces, choiceOf]);

  const submit = useCallback(() => {
    if (!canEdit || saving) return;
    const decisions: FaceDecision[] = faces.map((f) => {
      const c = choiceOf(f.id);
      return c.action === "other" ? { faceId: f.id, action: "other", entityId: c.entityId } : { faceId: f.id, action: c.action };
    });
    setMessage(null);
    startTransition(async () => {
      const r = await submitFaceReview(decisions);
      if (!r.ok) {
        setMessage(`保存できませんでした: ${r.error}`);
        return;
      }
      setMessage(`${r.result.updated} 顔を保存しました (タグ +${r.result.tagsAdded} / -${r.result.tagsRemoved})`);
      router.refresh();
    });
  }, [canEdit, saving, faces, choiceOf, router]);

  // キーボード
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (picker) return; // メンバーを選んでいる間は picker が受ける
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const move = (d: number) => {
        e.preventDefault();
        setCursor((c) => Math.min(Math.max(c + d, 0), faces.length - 1));
      };
      const face = faces[cursor];
      const next = () => setCursor((c) => Math.min(c + 1, faces.length - 1));
      switch (e.key) {
        case "ArrowRight":
        case "l":
          return move(1);
        case "ArrowLeft":
        case "h":
          return move(-1);
        case "ArrowDown":
        case "j":
          return move(cols);
        case "ArrowUp":
        case "k":
          return move(-cols);
        case " ":
          e.preventDefault();
          if (face) {
            toggle(face.id);
            next();
          }
          return;
        case "n":
          if (face && canEdit) {
            setChoice(face.id, { action: "nonmember" });
            next();
          }
          return;
        case "m":
          if (face && canEdit) {
            e.preventDefault();
            setPicker(face.id);
          }
          return;
        case "Backspace":
        case "Delete":
          if (face) setChoice(face.id, null);
          return;
        case "Enter":
          e.preventDefault();
          return submit();
        case "o":
          if (face) window.open(`/assets/${face.assetId}`, "_blank", "noopener");
          return;
        case "[":
          if (nav.prevMember) router.push(nav.prevMember);
          return;
        case "]":
          if (nav.nextMember) router.push(nav.nextMember);
          return;
        case "t":
          router.push(nav.otherMode);
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const focused = faces[cursor];
  const names = [...new Set(faces.map((f) => f.predictedName))];

  return (
    <div className="flex gap-4 items-start">
      <div className="flex-1 min-w-0">
        <div ref={gridRef} className="flex flex-wrap gap-2">
          {faces.map((f, i) => {
            const c = choiceOf(f.id);
            const marked = choices.has(f.id);
            return (
              <button
                key={f.id}
                type="button"
                data-index={i}
                onClick={() => {
                  setCursor(i);
                  toggle(f.id);
                }}
                disabled={!canEdit}
                className={`relative shrink-0 rounded-lg overflow-hidden bg-slate-900 outline-none border-[3px] ${
                  i === cursor ? "ring-4 ring-sky-400 ring-offset-1" : ""
                } ${marked ? (c.action === "confirm" ? "border-emerald-500" : "border-rose-500") : "border-transparent"}`}
                style={{ width: TILE, height: TILE }}
                title={f.assetTitle}
              >
                <FaceCrop src={f.thumbnailUrl} bbox={f.bbox} size={TILE - 6} />
                <span className="absolute left-1 bottom-1 rounded bg-black/60 px-1 text-[11px] text-white">
                  {names.length > 1 ? `${f.predictedName} ` : ""}
                  {f.similarity?.toFixed(2) ?? "-"}
                </span>
                <ChoiceBadge choice={c} marked={marked} mode={mode} members={members} />
              </button>
            );
          })}
        </div>

        {canEdit ? (
          <div className="sticky bottom-0 mt-4 flex flex-wrap items-center gap-3 border-t border-slate-200 bg-white/95 py-3">
            <Button onClick={submit} disabled={saving}>
              {saving
                ? "保存中…"
                : mode === "pending"
                  ? `保存 (Enter): 本人 ${counts.confirm} 顔・その他 ${counts.other} 顔`
                  : `保存 (Enter): 確定 ${counts.confirm} 顔・外す ${counts.other} 顔`}
            </Button>
            {message && <span className="text-sm text-slate-700">{message}</span>}
          </div>
        ) : (
          <p className="mt-4 text-sm text-slate-500">確認できるのはメンバー以上です。</p>
        )}
      </div>

      <aside className="hidden lg:block w-80 shrink-0 sticky top-4 space-y-3">
        {focused && (
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <FocusedImage face={focused} />
            <div className="mt-2 text-xs text-slate-600 break-all">{focused.assetTitle}</div>
            <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
              <span>
                推定: {focused.predictedName} {focused.similarity?.toFixed(3) ?? ""}
              </span>
              <a href={`/assets/${focused.assetId}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-sky-700">
                画像を開く (o) <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
        )}
        <KeyHelp mode={mode} />
      </aside>

      {picker && (
        <MemberPicker
          members={members.filter((m) => m.id !== faces.find((f) => f.id === picker)?.predictedEntityId)}
          onPick={(entityId) => {
            setChoice(picker, { action: "other", entityId });
            setPicker(null);
            setCursor((c) => Math.min(c + 1, faces.length - 1));
          }}
          onCancel={() => setPicker(null)}
        />
      )}
    </div>
  );
}

function ChoiceBadge({ choice, marked, mode, members }: { choice: Choice; marked: boolean; mode: "pending" | "auto"; members: Member[] }) {
  if (!marked) {
    // 既定のまま。確認待ちは「本人ではない」側なので少し暗くする
    return mode === "pending" ? <span className="absolute inset-0 bg-black/25" /> : null;
  }
  if (choice.action === "confirm") {
    return (
      <span className="absolute right-1 top-1 rounded-full bg-emerald-500 p-0.5">
        <Check className="h-4 w-4 text-white" />
      </span>
    );
  }
  const label =
    choice.action === "other"
      ? members.find((m) => m.id === choice.entityId)?.name ?? "別の人"
      : choice.action === "nonmember"
        ? "メンバー以外"
        : null;
  return (
    <>
      <span className="absolute right-1 top-1 rounded-full bg-rose-500 p-0.5">
        <X className="h-4 w-4 text-white" />
      </span>
      {label && <span className="absolute left-1 top-1 max-w-[96px] truncate rounded bg-rose-600 px-1 text-[11px] text-white">{label}</span>}
    </>
  );
}

function KeyHelp({ mode }: { mode: "pending" | "auto" }) {
  const rows: [string, string][] = [
    ["← → ↑ ↓ / h l k j", "移動"],
    ["Space", mode === "pending" ? "本人として選ぶ (もう一度で戻す)" : "違う顔として外す (もう一度で戻す)"],
    ["n", "メンバー以外・顔ではない"],
    ["m", "別のメンバーを選ぶ"],
    ["Backspace", "選んだのを戻す"],
    ["Enter", "保存して次の 40 顔"],
    ["o", "元の画像を開く"],
    ["[ ]", "前 / 次のメンバー"],
    ["t", "確認待ち ⇄ 自動で付いた顔"],
  ];
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600">
      <div className="mb-1 font-medium text-slate-700">
        {mode === "pending" ? "選ばなかった顔は「推定のメンバーではない」で保存" : "選ばなかった顔は「推定どおり」で保存"}
      </div>
      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>
              <kbd className="rounded border border-slate-300 bg-slate-50 px-1 font-mono text-[11px]">{k}</kbd>
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** 別のメンバーを名前で絞って選ぶ (キーボードだけで: 打つ → ↑↓ → Enter / Esc) */
function MemberPicker({ members, onPick, onCancel }: { members: Member[]; onPick: (id: string) => void; onCancel: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const list = members.filter((m) => !q || m.name.includes(q) || `${m.generation}期`.includes(q));
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-32" onClick={onCancel}>
      <div className="w-80 rounded-lg bg-white p-3 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, list.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing && list[sel]) {
              e.preventDefault();
              onPick(list[sel].id);
            }
          }}
          placeholder="名前で絞る (Enter で決定・Esc で閉じる)"
          className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
        />
        <ul className="mt-2 max-h-72 overflow-y-auto text-sm">
          {list.map((m, i) => (
            <li
              key={m.id}
              onClick={() => onPick(m.id)}
              className={`cursor-pointer rounded px-2 py-1 ${i === sel ? "bg-sky-100 text-sky-900" : "text-slate-700"}`}
            >
              {m.generation}期 {m.name}
            </li>
          ))}
          {list.length === 0 && <li className="px-2 py-1 text-slate-400">見つかりません</li>}
        </ul>
      </div>
    </div>
  );
}

/** 選んでいる顔を、元の画像 (サムネイル) ごと大きく出し、顔に枠を付ける */
function FocusedImage({ face }: { face: Face }) {
  if (!face.thumbnailUrl) return <div className="h-48 rounded bg-slate-100" />;
  const [x1, y1, x2, y2] = face.bbox;
  return (
    <div className="relative">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={face.thumbnailUrl} alt="" className="block w-full rounded" />
      <span
        className="absolute rounded-sm border-2 border-sky-400"
        style={{ left: `${x1 * 100}%`, top: `${y1 * 100}%`, width: `${(x2 - x1) * 100}%`, height: `${(y2 - y1) * 100}%` }}
      />
    </div>
  );
}

/** サムネイルから顔の周りを切り抜いて見せる。枠は画像の幅・高さに対する 0〜1 の割合 */
export function FaceCrop({ src, bbox, size: tile = TILE }: { src: string | null; bbox: [number, number, number, number]; size?: number }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  if (!src) return <span className="absolute inset-0 flex items-center justify-center text-xs text-slate-400">画像なし</span>;
  const [x1, y1, x2, y2] = bbox;
  let style: React.CSSProperties = { opacity: 0 };
  if (size) {
    const side = Math.max((x2 - x1) * size.w, (y2 - y1) * size.h) * 1.6;
    const scale = tile / side;
    const cx = ((x1 + x2) / 2) * size.w * scale;
    const cy = ((y1 + y2) / 2) * size.h * scale;
    style = { width: size.w * scale, height: size.h * scale, left: tile / 2 - cx, top: tile / 2 - cy, maxWidth: "none" };
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      loading="lazy"
      className="absolute"
      style={style}
      onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
    />
  );
}
