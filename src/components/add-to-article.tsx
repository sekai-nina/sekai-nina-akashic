"use client";

import { useState, useTransition, useRef, useCallback, useLayoutEffect, useEffect } from "react";
import { createPortal } from "react-dom";
import { FileText, Check, Loader2 } from "lucide-react";
import { addAssetToArticleAction } from "@/app/(main)/articles/actions";
import { ARTICLE_TYPE_LABELS } from "@/lib/utils";

/** パネルの実寸。位置計算に使うので Tailwind のクラスと揃えること。 */
const PANEL_WIDTH = 288; // w-72
const PANEL_MAX_HEIGHT = 340;
const PANEL_MIN_HEIGHT = 160;
const PANEL_GAP = 4;
const VIEWPORT_MARGIN = 8;
/** 一度に描画する上限。超過分は検索で絞ってもらう */
const MAX_VISIBLE = 100;
/** 抜粋プレビューの文字数 (この後さらに line-clamp-2 が掛かる) */
const EXCERPT_PREVIEW = 60;

export interface PickerArticle {
  id: string;
  title: string;
  type: string | null;
}

interface AddToArticleProps {
  assetId: string;
  articles: PickerArticle[];
  /** 抜粋。テキスト範囲選択のフローターから渡される */
  excerpt?: {
    text: string;
    textType?: string;
    textStart?: number;
    textEnd?: number;
  };
  /** 紐づけ時に残すラベル (通常は asset.title) */
  defaultLabel?: string;
  variant?: "icon" | "button";
  /** 既に紐づいている記事 id (グレーアウト用) */
  alreadyAdded?: string[];
  size?: "sm" | "md";
  /** 紐づけ成功後に呼ばれる。呼び出し側で完了表示を出すため */
  onAdded?: (articleId: string, articleTitle: string) => void;
}

export function AddToArticle({
  assetId,
  articles,
  excerpt,
  defaultLabel,
  variant = "icon",
  alreadyAdded = [],
  size = "sm",
  onAdded,
}: AddToArticleProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set(alreadyAdded));
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(
    null,
  );

  // トリガーがビューポート端にあってもパネルが画面外に出ないよう、
  // 実際の位置を測って上下反転・左右クランプする。
  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - VIEWPORT_MARGIN;
    const openUpward = spaceBelow < Math.min(PANEL_MAX_HEIGHT, spaceAbove);
    const maxHeight = Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_MAX_HEIGHT, openUpward ? spaceAbove : spaceBelow));
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN),
    );
    setPosition({
      top: openUpward ? rect.top - maxHeight - PANEL_GAP : rect.bottom + PANEL_GAP,
      left,
      maxHeight,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, updatePosition]);

  // パネル外クリック・Esc で閉じる
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      // 属性ベースだと同一画面の別インスタンスをクリックしても閉じないので
      // 自分のアンカー / パネルに含まれるかで判定する
      if (t && (anchorRef.current?.contains(t) || panelRef.current?.contains(t))) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = query.trim()
    ? articles.filter((a) => a.title.toLowerCase().includes(query.trim().toLowerCase()))
    : articles;

  const add = (article: PickerArticle) => {
    if (addedIds.has(article.id) || isPending) return;
    setPendingId(article.id);
    setError(null);
    startTransition(async () => {
      try {
        // excerptType は string のまま渡す。Server Action 側が enum に絞り込む
        await addAssetToArticleAction(article.id, assetId, {
          label: defaultLabel,
          excerpt: excerpt?.text,
          excerptType: excerpt?.textType,
          excerptStart: excerpt?.textStart,
          excerptEnd: excerpt?.textEnd,
        });
        setAddedIds((prev) => new Set(prev).add(article.id));
        onAdded?.(article.id, article.title);
      } catch (e) {
        // 握り潰すと「押したのに何も起きない」になる
        setError(e instanceof Error ? e.message : "紐づけに失敗しました");
      } finally {
        setPendingId(null);
      }
    });
  };

  return (
    <div ref={anchorRef} className="inline-block" data-article-picker>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="記事に紐づける"
        className={
          variant === "button"
            ? "inline-flex items-center gap-1 px-2 py-1 rounded text-xs border border-slate-300 hover:bg-slate-50"
            : `inline-flex items-center justify-center rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100 ${
                size === "sm" ? "w-6 h-6" : "w-8 h-8"
              }`
        }
      >
        <FileText size={size === "sm" ? 14 : 16} />
        {variant === "button" && <span>記事に紐づけ</span>}
      </button>

      {open &&
        position &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: "fixed",
              top: position.top,
              left: position.left,
              width: PANEL_WIDTH,
              maxHeight: position.maxHeight,
            }}
            className="z-50 bg-white border border-slate-200 rounded-lg shadow-lg flex flex-col overflow-hidden"
          >
            <div className="p-2 border-b border-slate-100">
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="記事を検索"
                className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded"
              />
              {excerpt?.text && (
                <p className="mt-1.5 text-xs text-slate-400 line-clamp-2">
                  抜粋: {excerpt.text.slice(0, EXCERPT_PREVIEW)}
                </p>
              )}
            </div>

            {error && (
              <p className="px-3 py-2 text-xs text-red-600 bg-red-50 border-b border-red-100">
                {error}
              </p>
            )}

            <div className="overflow-y-auto flex-1">
              {filtered.length === 0 && (
                <p className="px-3 py-4 text-center text-xs text-slate-400">該当なし</p>
              )}
              {filtered.slice(0, MAX_VISIBLE).map((a) => {
                const added = addedIds.has(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => add(a)}
                    disabled={added || isPending}
                    className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                      added ? "text-slate-400" : "text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    {pendingId === a.id ? (
                      <Loader2 size={13} className="animate-spin shrink-0" />
                    ) : added ? (
                      <Check size={13} className="shrink-0 text-emerald-600" />
                    ) : (
                      <span className="w-[13px] shrink-0" />
                    )}
                    <span className="truncate flex-1">{a.title}</span>
                    {a.type && (
                      <span className="text-[10px] text-slate-400 shrink-0">
                        {ARTICLE_TYPE_LABELS[a.type] ?? a.type}
                      </span>
                    )}
                  </button>
                );
              })}
              {filtered.length > MAX_VISIBLE && (
                <p className="px-3 py-2 text-center text-xs text-slate-400">
                  他 {filtered.length - MAX_VISIBLE} 件 — 検索で絞り込んでください
                </p>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
