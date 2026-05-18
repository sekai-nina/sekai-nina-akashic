"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Quote, Check, ExternalLink } from "lucide-react";
import { AddToDossier } from "@/components/add-to-dossier";

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
  embeddedImages: Record<string, EmbeddedImage>;
  editableDossiers: EditableDossier[];
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
}: TextsSectionProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeSelection, setActiveSelection] = useState<Selection>(null);

  useEffect(() => {
    if (editableDossiers.length === 0) return;

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
              <RichTextContent content={text.content} embeddedImages={embeddedImages} />
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

function RichTextContent({
  content,
  embeddedImages,
}: {
  content: string;
  embeddedImages: Record<string, EmbeddedImage>;
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
              <Link key={i} href={`/assets/${assetId}`} className="block my-2 select-none" contentEditable={false}>
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
        return <span key={i}>{part}</span>;
      })}
    </div>
  );
}

function ExcerptFloater({
  selection,
  assetId,
  assetTitle,
  editableDossiers,
  onDone,
}: {
  selection: NonNullable<Selection>;
  assetId: string;
  assetTitle: string;
  editableDossiers: EditableDossier[];
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
