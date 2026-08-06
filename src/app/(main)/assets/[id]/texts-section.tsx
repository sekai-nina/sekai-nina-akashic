"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Quote, Check, ExternalLink } from "lucide-react";
import { AddToDossier } from "@/components/add-to-dossier";
import { AddToArticle, type PickerArticle } from "@/components/add-to-article";
import { rememberScroll, useRestoreScroll } from "./scroll-return";

const TEXT_TYPE_LABELS: Record<string, string> = {
  title: "タイトル",
  body: "本文",
  description: "説明",
  message_body: "メッセージ本文",
  ocr: "OCR",
  transcript: "文字起こし",
  note: "メモ",
  extracted: "抽出テキスト",
};

interface EmbeddedImage {
  thumbnailUrl: string | null;
  title: string;
}

interface AssetText {
  id: string;
  textType: string;
  content: string;
}

interface EditableDossier {
  id: string;
  title: string;
}

interface TextsSectionProps {
  assetId: string;
  assetTitle: string;
  texts: AssetText[];
  /** 抜粋の紐づけ先候補。空配列なら記事ボタンを出さない */
  articles?: PickerArticle[];
  embeddedImages: Record<string, EmbeddedImage>;
  editableDossiers: EditableDossier[];
  /** 言及ハイライト語彙（?hl=nina 時のみ非空。長い語が先＝交替の優先順） */
  highlightTerms?: string[];
}

type Selection = {
  text: string;
  textType: string;
  rect: DOMRect;
} | null;

export function TextsSection({
  assetId,
  assetTitle,
  texts,
  embeddedImages,
  editableDossiers,
  articles = [],
  highlightTerms = [],
}: TextsSectionProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeSelection, setActiveSelection] = useState<Selection>(null);

  // 本文中の画像から戻ってきたときに、元のスクロール位置に復帰させる
  useRestoreScroll(assetId, containerRef);

  useEffect(() => {
    if (editableDossiers.length === 0 && articles.length === 0) return;

    function handleUp(e: MouseEvent) {
      // Ignore clicks originating inside the floater itself (popover, buttons),
      // otherwise focus changes can collapse the text selection and unmount us
      // mid-action.
      const target = e.target as Element | null;
      if (target && target.closest("[data-excerpt-floater]")) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setActiveSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const container = containerRef.current;
      if (!container) return;

      // Selection must start AND end within our container
      if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
        setActiveSelection(null);
        return;
      }

      const startPanel = nearestPanel(range.startContainer);
      const endPanel = nearestPanel(range.endContainer);
      if (!startPanel || startPanel !== endPanel) {
        // Don't allow cross-panel selections
        setActiveSelection(null);
        return;
      }

      const text = sel.toString().trim();
      if (!text) {
        setActiveSelection(null);
        return;
      }

      const rect = range.getBoundingClientRect();
      setActiveSelection({
        text,
        textType: startPanel.dataset.textType ?? "body",
        rect,
      });
    }

    function handleDown(e: MouseEvent) {
      // Dismiss when clicking outside the floater
      const target = e.target as Element | null;
      if (target && target.closest("[data-excerpt-floater]")) return;
      // Wait for the mouseup event to recompute selection
    }

    document.addEventListener("mouseup", handleUp);
    document.addEventListener("mousedown", handleDown);
    return () => {
      document.removeEventListener("mouseup", handleUp);
      document.removeEventListener("mousedown", handleDown);
    };
  }, [editableDossiers.length]);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">テキスト</h2>
        {editableDossiers.length > 0 && (
          <span className="text-[10px] text-slate-400">本文を選択するとドシエに引用追加できます</span>
        )}
      </div>

      <div ref={containerRef}>
        <ul className="space-y-3">
          {texts.map((text) => (
            <li
              key={text.id}
              data-text-id={text.id}
              data-text-type={text.textType}
              className="border border-slate-100 rounded-lg p-3"
            >
              <div className="mb-1.5">
                <span className="text-xs font-medium bg-teal-100 text-teal-700 px-2 py-0.5 rounded">
                  {TEXT_TYPE_LABELS[text.textType] ?? text.textType}
                </span>
              </div>
              <RichTextContent
                content={text.content}
                embeddedImages={embeddedImages}
                highlightTerms={highlightTerms}
                onImageNavigate={(imageAssetId, imageEl) =>
                  rememberScroll(assetId, imageAssetId, imageEl)
                }
              />
            </li>
          ))}
        </ul>
      </div>

      {activeSelection && (
        <ExcerptFloater
          selection={activeSelection}
          assetId={assetId}
          assetTitle={assetTitle}
          editableDossiers={editableDossiers}
          articles={articles}
          onDone={() => setActiveSelection(null)}
        />
      )}
    </div>
  );
}

function nearestPanel(node: Node): HTMLLIElement | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return el ? (el.closest("li[data-text-id]") as HTMLLIElement | null) : null;
}

function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * テキストを一致語で分割し、一致箇所を <mark data-hl="nina"> に置き換えた React ノード列を返す。
 * dangerouslySetInnerHTML を使わない（XSS 安全）。capture group 付き split のため
 * 奇数インデックスが一致セグメント。terms は長い語が先（「坂井新奈」>「坂井」）。
 */
function highlightNodes(text: string, terms: string[], keyBase: string): ReactNode {
  if (terms.length === 0 || !text) return text;
  const re = new RegExp(`(${terms.map(regexEscape).join("|")})`, "gi");
  const segs = text.split(re);
  if (segs.length === 1) return text;
  return segs.map((seg, i) =>
    i % 2 === 1 ? (
      <mark
        key={`${keyBase}-${i}`}
        data-hl="nina"
        className="bg-amber-200 text-slate-900 rounded px-0.5"
      >
        {seg}
      </mark>
    ) : (
      seg
    )
  );
}

function RichTextContent({
  content,
  embeddedImages,
  highlightTerms = [],
  onImageNavigate,
}: {
  content: string;
  embeddedImages: Record<string, EmbeddedImage>;
  highlightTerms?: string[];
  /** 本文中の画像から離れる直前に呼ばれる（戻ってきたときの復元用） */
  onImageNavigate?: (imageAssetId: string, imageEl: HTMLElement) => void;
}) {
  const parts = content.split(/(\{\{IMG:[a-zA-Z0-9_-]+\}\})/);
  return (
    <div className="text-sm text-slate-700 whitespace-pre-wrap select-text">
      {parts.map((part, i) => {
        const match = part.match(/^\{\{IMG:([a-zA-Z0-9_-]+)\}\}$/);
        if (match) {
          const assetId = match[1];
          const img = embeddedImages[assetId];
          if (img?.thumbnailUrl) {
            return (
              <Link
                key={i}
                href={`/assets/${assetId}`}
                onClick={(e) => onImageNavigate?.(assetId, e.currentTarget)}
                className="block my-2 select-none"
                contentEditable={false}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.thumbnailUrl}
                  alt={img.title || ""}
                  className="max-w-full rounded-lg border border-slate-200 hover:opacity-90 transition-opacity"
                  loading="lazy"
                />
              </Link>
            );
          }
          return null;
        }
        return <span key={i}>{highlightNodes(part, highlightTerms, `hl-${i}`)}</span>;
      })}
    </div>
  );
}

function ExcerptFloater({
  selection,
  assetId,
  assetTitle,
  editableDossiers,
  articles,
  onDone,
}: {
  selection: NonNullable<Selection>;
  assetId: string;
  assetTitle: string;
  editableDossiers: EditableDossier[];
  articles: PickerArticle[];
  onDone: () => void;
}) {
  const [confirmation, setConfirmation] = useState<{ id: string; title: string } | null>(null);

  // Position the floater above the selection (clamped to viewport)
  const top = window.scrollY + selection.rect.top - 38;
  const baseLeft = window.scrollX + selection.rect.left + selection.rect.width / 2;
  const left = confirmation ? baseLeft - 130 : baseLeft - 80;

  useEffect(() => {
    if (!confirmation) return;
    const t = setTimeout(() => onDone(), 3500);
    return () => clearTimeout(t);
  }, [confirmation, onDone]);

  if (confirmation) {
    return (
      <div
        data-excerpt-floater
        style={{ position: "absolute", top, left, zIndex: 60 }}
        className="bg-emerald-600 text-white rounded-lg shadow-lg px-3 py-1.5 flex items-center gap-2"
      >
        <Check className="h-3.5 w-3.5" />
        <span className="text-[11px]">
          「<span className="font-semibold">{confirmation.title}</span>」に引用を追加しました
        </span>
        <Link
          href={`/dossiers/${confirmation.id}`}
          className="inline-flex items-center gap-0.5 text-[11px] underline underline-offset-2 hover:text-emerald-100"
        >
          開く <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
    );
  }

  return (
    <div
      data-excerpt-floater
      style={{ position: "absolute", top, left, zIndex: 60 }}
      className="bg-slate-900 text-white rounded-lg shadow-lg px-2 py-1 flex items-center gap-2"
    >
      <Quote className="h-3 w-3" />
      <span className="text-[11px]">この箇所を引用</span>
      <AddToDossier
        assetId={assetId}
        dossiers={editableDossiers}
        defaultCaption={assetTitle}
        excerpt={{ text: selection.text, textType: selection.textType }}
        variant="button"
        onAdded={(id, title) => setConfirmation({ id, title })}
      />
      {articles.length > 0 && (
        <AddToArticle
          assetId={assetId}
          articles={articles}
          defaultLabel={assetTitle}
          excerpt={{ text: selection.text, textType: selection.textType }}
          variant="button"
        />
      )}
      <button
        type="button"
        onClick={onDone}
        className="text-white/60 hover:text-white text-[11px] ml-1"
      >
        ×
      </button>
    </div>
  );
}
