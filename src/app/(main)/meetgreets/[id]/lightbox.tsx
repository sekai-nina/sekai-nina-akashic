"use client";

import { useEffect, useRef } from "react";

/**
 * 画像の拡大表示 (#135)。素材もレポの写真もこれを使う。
 *
 * `/gallery` の同等の実装に合わせて Esc と背面のスクロール止めを入れ、加えて
 * **開いたら閉じるボタンに focus を移し、閉じたら元の位置へ戻す**
 * (キーボードだけで開くと、閉じた後どこにいるか分からなくなるため)。
 */
export function Lightbox({
  src,
  alt,
  onClose,
}: {
  src: string | null;
  alt: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!src) return;
    openerRef.current = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      const opener = openerRef.current;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [src, onClose]);

  if (!src) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="画像の拡大"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-5 cursor-zoom-out"
      onClick={onClose}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="max-w-[96vw] max-h-[96vh] rounded-lg" />
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 h-9 px-3 rounded-md bg-white/90 text-sm text-slate-800 hover:bg-white"
      >
        閉じる
      </button>
    </div>
  );
}
