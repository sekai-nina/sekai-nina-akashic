"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import {
  ArrowUp,
  ArrowDown,
  ExternalLink,
  HardDrive,
  Image as ImageIcon,
  FileText,
  Video,
  Quote,
  Trash2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import {
  updateItemAction,
  removeItemAction,
  reorderItemsAction,
} from "../actions";

type Item = {
  id: string;
  kind: string;
  caption: string;
  note: string;
  excerpt: string;
  excerptType: string | null;
  excerptStart: number | null;
  excerptEnd: number | null;
  externalUrl: string | null;
  externalImageKey: string | null;
  externalImageThumbKey: string | null;
  externalImageUrl?: string | null;
  externalImageThumbnailUrl?: string | null;
  sortOrder: number;
  asset:
    | {
        id: string;
        kind: string;
        title: string;
        canonicalDate: Date | string | null;
        thumbnailUrl: string | null;
        storageProvider: string;
        storageUrl: string | null;
        storageKey: string | null;
      }
    | null;
};

interface ItemRowProps {
  dossierId: string;
  item: Item;
  editable: boolean;
  isFirst: boolean;
  isLast: boolean;
  orderedIds: string[];
  indexInList: number;
}

function parseLinks(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const LINK_COLLAPSE_THRESHOLD = 3;

function LinkList({ urls }: { urls: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = urls.length > LINK_COLLAPSE_THRESHOLD;
  const visible = collapsible && !expanded ? urls.slice(0, LINK_COLLAPSE_THRESHOLD) : urls;

  return (
    <div className="space-y-1">
      {visible.map((url, i) => (
        <a
          key={i}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-[11px] text-indigo-600 hover:underline break-all"
        >
          <ExternalLink className="h-3 w-3 shrink-0" /> {url}
        </a>
      ))}
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600"
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3 w-3" /> 折りたたむ
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" /> 他 {urls.length - LINK_COLLAPSE_THRESHOLD} 件を表示
            </>
          )}
        </button>
      )}
    </div>
  );
}

function driveUrl(asset: NonNullable<Item["asset"]>): string | null {
  if (asset.storageProvider !== "gdrive") return null;
  if (asset.storageUrl) return asset.storageUrl;
  if (asset.storageKey) return `https://drive.google.com/file/d/${asset.storageKey}/view`;
  return null;
}

export function DossierItemRow({ dossierId, item, editable, isFirst, isLast, orderedIds, indexInList }: ItemRowProps) {
  const [caption, setCaption] = useState(item.caption);
  const [note, setNote] = useState(item.note);
  const [excerpt, setExcerpt] = useState(item.excerpt);
  const [isPending, startTransition] = useTransition();

  function persist(field: "caption" | "note" | "excerpt", value: string, original: string) {
    if (value === original) return;
    const fd = new FormData();
    fd.set(field, value);
    fd.set("dossierId", dossierId);
    startTransition(() => updateItemAction(item.id, fd));
  }

  function move(direction: -1 | 1) {
    const target = indexInList + direction;
    if (target < 0 || target >= orderedIds.length) return;
    const next = [...orderedIds];
    [next[indexInList], next[target]] = [next[target], next[indexInList]];
    startTransition(() => reorderItemsAction(dossierId, next));
  }

  function handleRemove() {
    if (!confirm("このアイテムを削除しますか？")) return;
    startTransition(() => removeItemAction(item.id, dossierId));
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3 sm:p-4 flex gap-3">
      {/* Preview column */}
      <div className="shrink-0 w-24 sm:w-32">
        <ItemPreview item={item} />
      </div>

      {/* Body */}
      <div className="flex-1 min-w-0 space-y-2">
        <div className="flex items-start gap-2">
          {editable ? (
            <input
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              onBlur={() => persist("caption", caption, item.caption)}
              placeholder={item.asset?.title ?? "見出し"}
              className="flex-1 text-sm font-medium text-slate-900 bg-transparent outline-none border-b border-transparent focus:border-indigo-300"
            />
          ) : (
            <p className="flex-1 text-sm font-medium text-slate-900">
              {item.caption || item.asset?.title || "(無題)"}
            </p>
          )}
          {editable && (
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                disabled={isFirst || isPending}
                onClick={() => move(-1)}
                title="上へ"
                className="text-slate-300 hover:text-slate-600 disabled:opacity-30"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled={isLast || isPending}
                onClick={() => move(1)}
                title="下へ"
                className="text-slate-300 hover:text-slate-600 disabled:opacity-30"
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={handleRemove}
                disabled={isPending}
                title="削除"
                className="text-rose-300 hover:text-rose-600"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* Source link */}
        {item.asset ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Link
              href={`/assets/${item.asset.id}`}
              className="inline-flex items-center gap-1 text-[11px] text-indigo-600 hover:underline"
            >
              <KindIcon kind={item.asset.kind} />
              ソース: {item.asset.title || item.asset.id}
              {item.asset.canonicalDate && (
                <span className="text-slate-400">
                  · {typeof item.asset.canonicalDate === "string" ? item.asset.canonicalDate.slice(0, 10) : item.asset.canonicalDate.toISOString().slice(0, 10)}
                </span>
              )}
            </Link>
            {driveUrl(item.asset) && (
              <a
                href={driveUrl(item.asset)!}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-emerald-600 hover:underline"
              >
                <HardDrive className="h-3 w-3" /> Drive で開く
              </a>
            )}
          </div>
        ) : item.externalUrl ? (
          <LinkList urls={parseLinks(item.externalUrl)} />
        ) : null}

        {/* Excerpt (for text-bearing assets) */}
        {(item.excerpt || (editable && item.kind === "asset_ref" && item.asset && (item.asset.kind === "text" || item.asset.kind === "document"))) && (
          <div className="rounded border-l-2 border-slate-300 bg-slate-50/60 px-2 py-1.5">
            <div className="flex items-center gap-1 mb-1 text-[10px] text-slate-400">
              <Quote className="h-2.5 w-2.5" /> 抜粋{item.excerptType ? ` · ${item.excerptType}` : ""}
            </div>
            {editable ? (
              <textarea
                value={excerpt}
                onChange={(e) => setExcerpt(e.target.value)}
                onBlur={() => persist("excerpt", excerpt, item.excerpt)}
                rows={Math.min(6, Math.max(2, excerpt.split("\n").length))}
                placeholder="抜粋テキスト (本文を選択して保存も可)"
                className="w-full text-xs text-slate-700 bg-transparent outline-none resize-none"
              />
            ) : (
              <p className="text-xs text-slate-700 whitespace-pre-wrap">{item.excerpt}</p>
            )}
          </div>
        )}

        {/* Note */}
        {(item.note || editable) && (
          <div>
            {editable ? (
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onBlur={() => persist("note", note, item.note)}
                rows={Math.min(4, Math.max(1, note.split("\n").length))}
                placeholder="メモ"
                className="w-full text-xs text-slate-600 bg-transparent outline-none resize-none border border-transparent rounded px-1 py-0.5 focus:border-slate-200"
              />
            ) : (
              <p className="text-xs text-slate-600 whitespace-pre-wrap">{item.note}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function KindIcon({ kind }: { kind: string }) {
  if (kind === "image") return <ImageIcon className="h-3 w-3" />;
  if (kind === "video") return <Video className="h-3 w-3" />;
  return <FileText className="h-3 w-3" />;
}

function ItemPreview({ item }: { item: Item }) {
  if (item.kind === "external_image") {
    const fullSrc = item.externalImageUrl ?? null;
    const thumbSrc = item.externalImageThumbnailUrl ?? fullSrc;
    if (!thumbSrc) return <PlaceholderBlock label="外部画像" />;
    return (
      <a
        href={fullSrc ?? thumbSrc}
        target="_blank"
        rel="noopener noreferrer"
        className="block group"
        title="画像を開く"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={thumbSrc}
          alt={item.caption}
          className="w-full h-24 sm:h-32 object-cover rounded bg-slate-100 group-hover:opacity-90 transition-opacity"
        />
      </a>
    );
  }
  if (item.kind === "external_link") {
    const n = parseLinks(item.externalUrl).length;
    return (
      <PlaceholderBlock
        label={n > 1 ? `外部リンク ${n}` : "外部リンク"}
        icon={<ExternalLink className="h-5 w-5" />}
      />
    );
  }
  // asset_ref
  if (!item.asset) return <PlaceholderBlock label="アセット未参照" />;
  const a = item.asset;
  if (a.thumbnailUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={a.thumbnailUrl} alt={a.title} className="w-full h-24 sm:h-32 object-cover rounded bg-slate-100" />;
  }
  if (a.kind === "video") return <PlaceholderBlock label="動画" icon={<Video className="h-5 w-5" />} />;
  if (a.kind === "image") return <PlaceholderBlock label="画像" icon={<ImageIcon className="h-5 w-5" />} />;
  return <PlaceholderBlock label="テキスト" icon={<FileText className="h-5 w-5" />} />;
}

function PlaceholderBlock({ label, icon }: { label: string; icon?: React.ReactNode }) {
  return (
    <div className="w-full h-24 sm:h-32 bg-slate-100 rounded flex flex-col items-center justify-center text-slate-400">
      {icon}
      <span className="text-[10px] mt-1">{label}</span>
    </div>
  );
}
