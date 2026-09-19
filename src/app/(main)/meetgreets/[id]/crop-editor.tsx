"use client";

import { useEffect, useRef, useState } from "react";
import type { CropRect } from "@/lib/meetgreet/crop";

/**
 * 参照写真の切り抜き枠を引く (#136)。
 *
 * ミーグリの写真はツーショットが多く、そのまま渡すと隣の人の服を拾う。
 * 本人のところだけを囲ってもらう。
 *
 * **枠は割合 (0〜1) で返す。** ここで見ているのはサムネイルだが、生成に使うのは
 * Drive の原本なので、画素で返すと合わない。
 */
export function CropEditor({
  src,
  title,
  value,
  onSave,
  onClear,
  onClose,
  saving,
}: {
  src: string;
  title: string;
  value: CropRect | null;
  onSave: (rect: CropRect) => void;
  onClear: () => void;
  onClose: () => void;
  saving: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<CropRect | null>(value);
  /** ドラッグ中の起点 (割合) */
  const anchor = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  /** 画面の座標を、画像に対する割合に直す */
  function toFraction(e: { clientX: number; clientY: number }) {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return null;
    return {
      x: clamp01((e.clientX - box.left) / box.width),
      y: clamp01((e.clientY - box.top) / box.height),
    };
  }

  function onPointerDown(e: React.PointerEvent) {
    const p = toFraction(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    anchor.current = p;
    setRect({ x: p.x, y: p.y, w: 0, h: 0 });
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!anchor.current) return;
    const p = toFraction(e);
    if (!p) return;
    const a = anchor.current;
    setRect({
      x: Math.min(a.x, p.x),
      y: Math.min(a.y, p.y),
      w: Math.abs(p.x - a.x),
      h: Math.abs(p.y - a.y),
    });
  }

  function onPointerUp() {
    anchor.current = null;
  }

  // 小さすぎる枠は保存させない (生成側で無視され、切ったつもりで切れていないことになる)
  const tooSmall = !rect || rect.w < 0.02 || rect.h < 0.02;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${title} の切り抜き`}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/85 p-5"
    >
      <p className="text-xs text-white/80 text-center max-w-md">
        参照に使うところを囲ってください。ツーショットなら本人だけを囲うと、隣の人の服を拾わなくなります。
      </p>

      <div
        ref={boxRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="relative inline-block touch-none cursor-crosshair select-none"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={title} className="block max-w-[92vw] max-h-[60vh] rounded" draggable={false} />
        {rect && rect.w > 0 && rect.h > 0 && (
          // 囲った外側だけを暗くする (窓の周り 4 枚で覆う。中は元の画像がそのまま見える)
          <div className="absolute inset-0 pointer-events-none">
            <Shade style={{ left: 0, top: 0, right: 0, height: `${rect.y * 100}%` }} />
            <Shade style={{ left: 0, top: `${(rect.y + rect.h) * 100}%`, right: 0, bottom: 0 }} />
            <Shade
              style={{
                left: 0,
                top: `${rect.y * 100}%`,
                width: `${rect.x * 100}%`,
                height: `${rect.h * 100}%`,
              }}
            />
            <Shade
              style={{
                left: `${(rect.x + rect.w) * 100}%`,
                top: `${rect.y * 100}%`,
                right: 0,
                height: `${rect.h * 100}%`,
              }}
            />
            <div
              className="absolute border-2 border-white"
              style={{
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.w * 100}%`,
                height: `${rect.h * 100}%`,
              }}
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap justify-center">
        <button
          type="button"
          onClick={() => rect && onSave(rect)}
          disabled={saving || tooSmall}
          className="h-9 px-4 rounded-md bg-white text-sm text-slate-900 hover:bg-slate-100 disabled:opacity-50"
        >
          この範囲で使う
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={saving || !value}
          className="h-9 px-3 rounded-md border border-white/40 text-sm text-white hover:bg-white/10 disabled:opacity-40"
        >
          切り抜きをやめる（画像全体を使う）
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="h-9 px-3 rounded-md text-sm text-white/80 hover:text-white"
        >
          閉じる
        </button>
      </div>
      {tooSmall && rect && (
        <p className="text-[11px] text-amber-200">範囲が小さすぎます。もう少し大きく囲ってください。</p>
      )}
    </div>
  );
}

function Shade({ style }: { style: React.CSSProperties }) {
  return <div className="absolute bg-black/60" style={style} />;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
