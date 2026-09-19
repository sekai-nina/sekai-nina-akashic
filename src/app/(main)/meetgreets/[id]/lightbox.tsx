"use client";

import { useEffect } from "react";

/**
 * 画像の拡大表示 (#135)。素材もレポの写真もこれを使う。
 * `/repo` の同等の実装と違い、Esc で閉じられる (キーボードだけで抜けられないと閉じ込める)。
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
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [src, onClose]);

  if (!src) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt || "画像の拡大"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-5 cursor-zoom-out"
      onClick={onClose}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="max-w-[96vw] max-h-[96vh] rounded-lg" />
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 h-9 px-3 rounded-md bg-white/90 text-sm text-slate-800 hover:bg-white"
      >
        閉じる
      </button>
    </div>
  );
}
