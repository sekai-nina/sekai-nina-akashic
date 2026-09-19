"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Quote, Check, ExternalLink, Scissors } from "lucide-react";
import { AddToDossier } from "@/components/add-to-dossier";
import { AddToArticle, type PickerArticle } from "@/components/add-to-article";
import { ClipDialog, type ClipDraft } from "@/components/clip-dialog";
import { IMG_PLACEHOLDER_RE, stripImagePlaceholders } from "@/lib/utils";
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

/** 本文上に色付けする範囲 (クリップ済みの抜粋。#41)。位置は content の文字添字 */
export interface TextRange {
  id: string;
  start: number;
  end: number;
}

interface TextsSectionProps {
  assetId: string;
  assetTitle: string;
  texts: AssetText[];
  /** 抜粋の紐づけ先候補。空配列なら記事ボタンを出さない */
  articles?: PickerArticle[];
  embeddedImages: Record<string, EmbeddedImage>;
  editableDossiers: EditableDossier[];
  /** クリップを作れるか (admin / member)。フローターに「クリップ」を出す */
  canClip?: boolean;
  /** テキスト id → クリップ済みの範囲 */
  clipRanges?: Record<string, TextRange[]>;
  /** 言及ハイライト語彙（?hl=nina 時のみ非空。長い語が先＝交替の優先順） */
  highlightTerms?: string[];
}

type Selection = {
  text: string;
  textType: string;
  /** content 内の位置。DOM から復元できなかったときは undefined (文字列だけ渡す) */
  start?: number;
  end?: number;
  rect: DOMRect;
} | null;

export function TextsSection({
  assetId,
  assetTitle,
  texts,
  embeddedImages,
  editableDossiers,
  articles = [],
  canClip = false,
  clipRanges = {},
  highlightTerms = [],
}: TextsSectionProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeSelection, setActiveSelection] = useState<Selection>(null);
  // クリップのフォームはフローターの外 (このコンポーネント) で持つ。フローターは選択が
  // 解除されると消えるので、その中にダイアログを置くと入力中に巻き添えで閉じる
  const [clipDraft, setClipDraft] = useState<ClipDraft | null>(null);
  // 親が毎回新しい配列を渡してくるので、mouseup ハンドラの購読し直しを避けるため ref で持つ
  const textsRef = useRef(texts);
  useEffect(() => {
    textsRef.current = texts;
  }, [texts]);

  // 本文中の画像から戻ってきたときに、元のスクロール位置に復帰させる
  useRestoreScroll(assetId, containerRef);

  useEffect(() => {
    if (!canClip && editableDossiers.length === 0 && articles.length === 0) return;

    function handleUp(e: MouseEvent) {
      // フローター自身（およびそこから開くピッカー）の中のクリックは無視する。
      // 無視しないと、フォーカス移動で選択が collapse され、操作の途中で
      // フローターごとアンマウントされてしまう。
      // ピッカーのパネルは createPortal で body 直下に出ているため、DOM 上は
      // フローターの子孫にならない。data-picker-panel を別途見る必要がある。
      const target = e.target as Element | null;
      if (isInsideFloater(target)) return;
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

      const rect = range.getBoundingClientRect();
      const textType = startPanel.dataset.textType ?? "body";

      // 選択範囲を content の文字添字に直す (クリップの位置と本文ハイライトに使う)
      const source = textsRef.current.find((t) => t.id === startPanel.dataset.textId);
      const contentEl = startPanel.querySelector<HTMLElement>("[data-text-content]");
      const located =
        source && contentEl ? locateSelection(range, contentEl, source.content) : null;
      if (located) {
        setActiveSelection({ text: located.text, textType, start: located.start, end: located.end, rect });
        return;
      }
      const text = sel.toString().trim();
      if (!text) {
        setActiveSelection(null);
        return;
      }
      setActiveSelection({ text, textType, rect });
    }

    function handleDown(e: MouseEvent) {
      // Dismiss when clicking outside the floater
      const target = e.target as Element | null;
      if (isInsideFloater(target)) return;
      // Wait for the mouseup event to recompute selection
    }

    document.addEventListener("mouseup", handleUp);
    document.addEventListener("mousedown", handleDown);
    return () => {
      document.removeEventListener("mouseup", handleUp);
      document.removeEventListener("mousedown", handleDown);
    };
  }, [editableDossiers.length, articles.length, canClip]);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">テキスト</h2>
        {(canClip || editableDossiers.length > 0) && (
          <span className="text-[10px] text-slate-400">
            本文を選択すると{canClip ? "クリップや" : ""}ドシエへの引用追加ができます
          </span>
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
                ranges={clipRanges[text.id] ?? []}
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
          canClip={canClip}
          onClip={() => {
            setClipDraft({
              excerpt: activeSelection.text,
              excerptType: activeSelection.textType,
              excerptStart: activeSelection.start,
              excerptEnd: activeSelection.end,
            });
            setActiveSelection(null);
          }}
          onDone={() => setActiveSelection(null)}
        />
      )}

      {canClip && (
        <ClipDialog
          assetId={assetId}
          hasTexts
          open={clipDraft !== null}
          onOpenChange={(open) => {
            if (!open) setClipDraft(null);
          }}
          draft={clipDraft ?? undefined}
        />
      )}
    </div>
  );
}

/**
 * DOM の選択範囲を content の文字添字に直す。
 *
 * 描画は `{{IMG:…}}` を画像に置き換える以外は content をそのまま文字列として出している
 * (`whitespace-pre-wrap`、ハイライトの <mark> もテキストは変えない) ので、
 * 「描画されたテキストの先頭から選択位置までの文字数」= 「content から画像プレースホルダを
 * 除いた文字数」になる。プレースホルダ分を足し戻せば content の添字になる。
 *
 * 前後の空白は落として返す (ハイライトが空白から始まらないように)。
 */
function locateSelection(
  range: Range,
  contentEl: HTMLElement,
  content: string
): { text: string; start: number; end: number } | null {
  const domStart = domOffsetBefore(contentEl, range.startContainer, range.startOffset);
  const domEnd = domOffsetBefore(contentEl, range.endContainer, range.endOffset);
  if (domStart == null || domEnd == null || domEnd <= domStart) return null;

  let start = domToContentOffset(content, domStart, "start");
  let end = domToContentOffset(content, domEnd, "end");
  while (start < end && /\s/.test(content[start])) start++;
  while (end > start && /\s/.test(content[end - 1])) end--;
  if (end <= start) return null;
  // 画像をまたいだ選択にはプレースホルダが入るが、抜粋の文字列には出さない
  // (サーバの保存形と同じ。位置は content の添字のまま)
  const text = stripImagePlaceholders(content.slice(start, end)).trim();
  if (!text) return null;
  return { text, start, end };
}

/** contentEl の描画テキスト先頭から (node, offset) までの文字数。contentEl の外なら null */
function domOffsetBefore(contentEl: HTMLElement, node: Node, offset: number): number | null {
  if (!contentEl.contains(node)) return null;
  const r = document.createRange();
  r.selectNodeContents(contentEl);
  r.setEnd(node, offset);
  return r.toString().length;
}

/**
 * 描画テキストの添字 → content の添字 (画像プレースホルダの分を足し戻す)。
 *
 * 画像のちょうど境目 (画像の直前 = 直後が同じ描画位置になる) は、選択の始点なら画像の
 * 後ろ、終点なら画像の手前に倒す。そうしないと抜粋の端に `{{IMG:…}}` が混ざる
 */
function domToContentOffset(content: string, domOffset: number, side: "start" | "end"): number {
  let shift = 0;
  for (const m of content.matchAll(IMG_PLACEHOLDER_RE)) {
    const domPos = m.index! - shift;
    if (side === "start" ? domPos > domOffset : domPos >= domOffset) break;
    shift += m[0].length;
  }
  return Math.min(content.length, domOffset + shift);
}

/**
 * フローター本体、またはそこから開いたピッカーのパネル内か。
 * パネルは createPortal で body 直下に出るので closest だけでは辿れない。
 */
function isInsideFloater(target: Element | null): boolean {
  return !!target?.closest("[data-excerpt-floater], [data-picker-panel]");
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

/**
 * 範囲 (クリップ済みの抜粋) で本文を切り分ける。重なりは境界で分割し、どれかに含まれて
 * いれば色付けする。境界は content の添字。返す配列は隙間なく content を覆う
 */
function splitByRanges(
  partStart: number,
  partEnd: number,
  ranges: TextRange[]
): { start: number; end: number; covered: boolean }[] {
  const bounds = new Set<number>([partStart, partEnd]);
  for (const r of ranges) {
    if (r.start > partStart && r.start < partEnd) bounds.add(r.start);
    if (r.end > partStart && r.end < partEnd) bounds.add(r.end);
  }
  const sorted = [...bounds].sort((a, b) => a - b);
  const out: { start: number; end: number; covered: boolean }[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    out.push({ start, end, covered: ranges.some((r) => r.start < end && r.end > start) });
  }
  return out;
}

function RichTextContent({
  content,
  embeddedImages,
  highlightTerms = [],
  ranges = [],
  onImageNavigate,
}: {
  content: string;
  embeddedImages: Record<string, EmbeddedImage>;
  highlightTerms?: string[];
  /** クリップ済みの範囲。content の添字 */
  ranges?: TextRange[];
  /** 本文中の画像から離れる直前に呼ばれる（戻ってきたときの復元用） */
  onImageNavigate?: (imageAssetId: string, imageEl: HTMLElement) => void;
}) {
  // 分割と添字変換 (domToContentOffset) で同じパターンを使う。ズレると選択位置が狂う
  const parts = content.split(new RegExp(`(${IMG_PLACEHOLDER_RE.source})`));
  // 各 part の content 内での開始位置 (範囲の切り分けに使う)
  let cursor = 0;
  const offsets = parts.map((part) => {
    const at = cursor;
    cursor += part.length;
    return at;
  });
  return (
    // data-text-content: 範囲選択を content の添字に直すときの基準 (locateSelection)。
    // この要素の描画テキストは、画像プレースホルダを除いた content と一致していなければならない
    <div data-text-content className="text-sm text-slate-700 whitespace-pre-wrap select-text">
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
        const partStart = offsets[i];
        const segments = splitByRanges(partStart, partStart + part.length, ranges);
        if (segments.length <= 1 && !segments[0]?.covered) {
          return <span key={i}>{highlightNodes(part, highlightTerms, `hl-${i}`)}</span>;
        }
        return (
          <span key={i}>
            {segments.map((seg) => {
              const text = content.slice(seg.start, seg.end);
              const nodes = highlightNodes(text, highlightTerms, `hl-${i}-${seg.start}`);
              return seg.covered ? (
                <mark
                  key={seg.start}
                  data-hl="clip"
                  title="クリップ済み"
                  className="bg-sky-100 text-slate-900 rounded-sm box-decoration-clone"
                >
                  {nodes}
                </mark>
              ) : (
                <span key={seg.start}>{nodes}</span>
              );
            })}
          </span>
        );
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
  canClip,
  onClip,
  onDone,
}: {
  selection: NonNullable<Selection>;
  assetId: string;
  assetTitle: string;
  editableDossiers: EditableDossier[];
  articles: PickerArticle[];
  canClip: boolean;
  onClip: () => void;
  onDone: () => void;
}) {
  const [confirmation, setConfirmation] = useState<{ id: string; title: string } | null>(null);
  const [articleConfirmation, setArticleConfirmation] = useState<string | null>(null);

  // 選択範囲の上・中央に出す。ボタンの数で幅が変わるので実寸を測って中央に寄せ、画面端で切れないよう clamp する
  const floaterRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    setWidth(floaterRef.current?.offsetWidth ?? 0);
  }, [confirmation, articleConfirmation, canClip, editableDossiers.length, articles.length]);
  const top = window.scrollY + selection.rect.top - 38;
  const center = window.scrollX + selection.rect.left + selection.rect.width / 2;
  const margin = 8;
  const left = Math.max(
    window.scrollX + margin,
    Math.min(center - width / 2, window.scrollX + window.innerWidth - width - margin)
  );

  useEffect(() => {
    if (!confirmation && !articleConfirmation) return;
    const t = setTimeout(() => onDone(), 3500);
    return () => clearTimeout(t);
  }, [confirmation, articleConfirmation, onDone]);

  if (articleConfirmation) {
    return (
      <div
        ref={floaterRef}
        data-excerpt-floater
        style={{ position: "absolute", top, left, zIndex: 60 }}
        className="bg-emerald-600 text-white rounded-lg shadow-lg px-3 py-1.5 flex items-center gap-2"
      >
        <Check className="h-3.5 w-3.5" />
        <span className="text-[11px]">
          記事「<span className="font-semibold">{articleConfirmation}</span>」に紐づけました
        </span>
      </div>
    );
  }

  if (confirmation) {
    return (
      <div
        ref={floaterRef}
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
      ref={floaterRef}
      data-excerpt-floater
      style={{ position: "absolute", top, left, zIndex: 60 }}
      className="bg-slate-900 text-white rounded-lg shadow-lg px-2 py-1 flex items-center gap-2"
    >
      <Quote className="h-3 w-3" />
      <span className="text-[11px]">この箇所を引用</span>
      {canClip && (
        <button
          type="button"
          onClick={onClip}
          title="クリップ (記事未定のまま取っておく)"
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs border border-sky-300 text-sky-100 hover:bg-sky-600/60"
        >
          <Scissors className="h-3.5 w-3.5" />
          <span>クリップ</span>
        </button>
      )}
      <AddToDossier
        assetId={assetId}
        dossiers={editableDossiers}
        defaultCaption={assetTitle}
        excerpt={{
          text: selection.text,
          textType: selection.textType,
          textStart: selection.start,
          textEnd: selection.end,
        }}
        variant="button"
        onAdded={(id, title) => setConfirmation({ id, title })}
      />
      {articles.length > 0 && (
        <AddToArticle
          assetId={assetId}
          articles={articles}
          defaultLabel={assetTitle}
          excerpt={{
            text: selection.text,
            textType: selection.textType,
            textStart: selection.start,
            textEnd: selection.end,
          }}
          variant="button"
          onAdded={(_id, title) => setArticleConfirmation(title)}
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
