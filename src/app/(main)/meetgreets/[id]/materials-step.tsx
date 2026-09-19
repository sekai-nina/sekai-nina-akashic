"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { Check, ChevronDown, ChevronRight, FileText, Image as ImageIcon, Video } from "lucide-react";
import type { AssetKind } from "@prisma/client";
import type { CandidateAsset, CandidateGroup } from "@/lib/meetgreet/candidates";
import { MATERIAL_WINDOW_DAYS } from "@/lib/meetgreet/config";
import { formatDate, MEETGREET_CANDIDATE_GROUP_LABELS } from "@/lib/utils";
import { applyMaterialsAction } from "../actions";
import { Lightbox } from "./lightbox";

/**
 * 素材候補のチェックリスト。初期チェックは suggested、既にドシエにあるものは固定表示。
 *
 * **中身を見て判断できることを優先する (#135)。** 題だけでは何のトークか分からないので
 * 本文の頭を出し、画像は並べて大きく見せる。チェックの付いていないテキストは数が多いので
 * 畳み、何も勧めていないグループ (別の話題のブログなど) はグループごと畳む。
 */
export function MaterialsStep({ meetGreetId, groups }: { meetGreetId: string; groups: CandidateGroup[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [expandedText, setExpandedText] = useState<Set<string>>(new Set());
  const [showAllText, setShowAllText] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState<{ url: string; title: string } | null>(null);

  const initial = useMemo(
    () => new Set(groups.flatMap((g) => g.assets.filter((a) => a.suggested).map((a) => a.id))),
    [groups]
  );
  const [selected, setSelected] = useState<Set<string>>(initial);
  // 反映して router.refresh() した後は候補の inDossier が変わる。チェックを入れ直す
  useEffect(() => setSelected(initial), [initial]);

  // 何も勧めておらず、ドシエにも入っていないグループは畳んでおく
  const initialClosed = useMemo(
    () =>
      new Set(
        groups
          .filter((g) => g.assets.every((a) => !a.suggested && !a.inDossier))
          .map((g) => g.key)
      ),
    [groups]
  );
  const [closed, setClosed] = useState<Set<string>>(initialClosed);
  useEffect(() => setClosed(initialClosed), [initialClosed]);

  const selectable = groups.flatMap((g) => g.assets.filter((a) => !a.inDossier));
  // 送るのは「まだドシエに無く、いま画面に出ていてチェックされているもの」だけ
  const targetIds = selectable.filter((a) => selected.has(a.id)).map((a) => a.id);

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** 畳んでいる行は選ばない (見えないものが黙って追加されるのを防ぐ) */
  function toggleGroup(ids: string[]) {
    const allOn = ids.length > 0 && ids.every((id) => selected.has(id));
    setSelected((s) => {
      const next = new Set(s);
      for (const id of ids) {
        if (allOn) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  function toggleIn(set: Set<string>, key: string, put: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    put(next);
  }

  function apply() {
    if (targetIds.length === 0) {
      setMsg("チェックされた素材がありません");
      return;
    }
    setMsg("反映中…");
    startTransition(async () => {
      const res = await applyMaterialsAction(meetGreetId, targetIds);
      setMsg(
        res.ok
          ? `${res.added} 件をドシエに追加しました${res.skipped > 0 ? ` (${res.skipped} 件は追加済み)` : ""}`
          : `エラー: ${res.error}`
      );
      if (res.ok) router.refresh();
    });
  }

  if (groups.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        候補がありません (当日〜{MATERIAL_WINDOW_DAYS} 日後に本人のブログ・トークが取り込まれていないか、まだ先の日付です)。
      </p>
    );
  }

  return (
    <div>
      <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
        {groups.map((g) => {
          const isClosed = closed.has(g.key);
          // チェックの付いていないテキストは数が多いので畳む (画像は常に出す)
          const hidden =
            showAllText.has(g.key) || isClosed
              ? []
              : g.assets.filter((a) => a.kind === "text" && !a.suggested && !a.inDossier);
          const hiddenIds = new Set(hidden.map((a) => a.id));
          const visible = isClosed ? [] : g.assets.filter((a) => !hiddenIds.has(a.id));
          const texts = visible.filter((a) => a.kind === "text");
          const media = visible.filter((a) => a.kind !== "text");
          const ids = visible.filter((a) => !a.inDossier).map((a) => a.id);
          const onCount = ids.filter((id) => selected.has(id)).length;

          return (
            <div key={g.key}>
              <div className="flex items-center gap-2 px-3 py-2 bg-slate-50">
                <button
                  type="button"
                  onClick={() => toggleIn(closed, g.key, setClosed)}
                  className="text-slate-400 hover:text-slate-700 shrink-0"
                  aria-expanded={!isClosed}
                  aria-label={`${groupName(g)} を${isClosed ? "開く" : "畳む"}`}
                >
                  {isClosed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
                {ids.length > 0 && (
                  <input
                    type="checkbox"
                    checked={onCount === ids.length}
                    ref={(el) => {
                      if (el) el.indeterminate = onCount > 0 && onCount < ids.length;
                    }}
                    onChange={() => toggleGroup(ids)}
                    aria-label={`${groupName(g)} をまとめてチェック`}
                  />
                )}
                <span className="text-[11px] rounded-full border border-slate-200 bg-white px-2 py-0.5 text-slate-600 shrink-0">
                  {MEETGREET_CANDIDATE_GROUP_LABELS[g.kind]}
                </span>
                {g.title && (
                  <span className="text-sm font-medium text-slate-800 truncate">
                    {g.url ? (
                      <a href={g.url} target="_blank" rel="noreferrer" className="hover:underline">
                        {g.title}
                      </a>
                    ) : (
                      g.title
                    )}
                  </span>
                )}
                {g.matched && (
                  <span className="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                    本文にミーグリの話
                  </span>
                )}
                <span className="ml-auto text-xs text-slate-400 tabular-nums shrink-0">
                  {isClosed ? `${g.assets.length} 件` : `${onCount}/${ids.length}`}
                </span>
              </div>

              {!isClosed && (
                <>
                  {texts.length > 0 && (
                    <ul className="divide-y divide-slate-50">
                      {texts.map((a) => (
                        <TextRow
                          key={a.id}
                          asset={a}
                          checked={selected.has(a.id)}
                          onToggle={() => toggle(a.id)}
                          expanded={expandedText.has(a.id)}
                          onExpand={() => toggleIn(expandedText, a.id, setExpandedText)}
                          showTime={g.kind === "talk"}
                        />
                      ))}
                    </ul>
                  )}

                  {media.length > 0 && (
                    <ul className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2 p-3">
                      {media.map((a) => (
                        <MediaTile
                          key={a.id}
                          asset={a}
                          checked={selected.has(a.id)}
                          onToggle={() => toggle(a.id)}
                          onZoom={() =>
                            a.thumbnailUrl && setZoom({ url: a.thumbnailUrl, title: a.title })
                          }
                        />
                      ))}
                    </ul>
                  )}

                  {hidden.length > 0 && (
                    <div className="px-3 py-1.5">
                      <button
                        type="button"
                        onClick={() => toggleIn(showAllText, g.key, setShowAllText)}
                        className="text-xs text-slate-500 hover:text-slate-800 underline underline-offset-2"
                      >
                        ミーグリの話が見つからなかったテキストも表示 ({hidden.length} 件)
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={apply}
          disabled={pending || targetIds.length === 0}
          className="h-9 px-4 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800 disabled:opacity-50"
        >
          ドシエに反映 ({targetIds.length})
        </button>
        {msg && (
          <span role="status" className="text-xs text-slate-500">
            {msg}
          </span>
        )}
      </div>

      <Lightbox
        src={zoom?.url ?? null}
        alt={zoom?.title ?? ""}
        onClose={() => setZoom(null)}
      />
    </div>
  );
}

/** テキスト 1 件。題だけでは判断できないので本文の頭を出す */
function TextRow({
  asset,
  checked,
  onToggle,
  expanded,
  onExpand,
  showTime,
}: {
  asset: CandidateAsset;
  checked: boolean;
  onToggle: () => void;
  expanded: boolean;
  onExpand: () => void;
  showTime: boolean;
}) {
  return (
    <li className="px-3 py-2">
      <div className="flex items-start gap-3">
        {asset.inDossier ? (
          <span className="inline-flex w-[13px] mt-1 justify-center text-emerald-600">
            <Check size={13} aria-hidden />
            <span className="sr-only">ドシエに追加済み</span>
          </span>
        ) : (
          <input
            type="checkbox"
            className="mt-1 shrink-0"
            checked={checked}
            onChange={onToggle}
            aria-label={asset.title}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span
              className={"text-sm truncate " + (asset.inDossier ? "text-slate-400" : "text-slate-800")}
            >
              {asset.title}
            </span>
            <span className="ml-auto text-xs text-slate-400 shrink-0">
              {asset.canonicalDate ? formatDate(asset.canonicalDate, showTime) : ""}
            </span>
          </div>
          {asset.textPreview && (
            <button
              type="button"
              onClick={onExpand}
              aria-expanded={expanded}
              className="mt-1 block w-full text-left text-xs text-slate-500 leading-relaxed whitespace-pre-wrap hover:text-slate-700"
            >
              <span className={expanded ? "" : "line-clamp-2"}>{asset.textPreview}</span>
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/** 画像 / 動画 1 件。何が写っているかで選ぶので、並べて大きく出す */
function MediaTile({
  asset,
  checked,
  onToggle,
  onZoom,
}: {
  asset: CandidateAsset;
  checked: boolean;
  onToggle: () => void;
  onZoom: () => void;
}) {
  const Icon = asset.kind === "video" ? Video : ImageIcon;
  return (
    <li>
      <div className="relative">
        {asset.thumbnailUrl ? (
          <button
            type="button"
            onClick={onZoom}
            className="block w-full aspect-square rounded-md overflow-hidden bg-slate-100 cursor-zoom-in"
            aria-label={`${asset.title} を拡大`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={asset.thumbnailUrl} alt={asset.title} className="w-full h-full object-cover" />
          </button>
        ) : (
          <span className="flex w-full aspect-square items-center justify-center rounded-md bg-slate-100 text-slate-400">
            <Icon size={20} />
          </span>
        )}
        <span className="absolute top-1 left-1 rounded bg-white/90 p-1 leading-none shadow-sm">
          {asset.inDossier ? (
            <>
              <Check size={13} className="text-emerald-600" aria-hidden />
              <span className="sr-only">{asset.title} はドシエに追加済み</span>
            </>
          ) : (
            <input
              type="checkbox"
              className="block"
              checked={checked}
              onChange={onToggle}
              aria-label={asset.title}
            />
          )}
        </span>
        {asset.kind === "video" && (
          <span className="absolute top-1 right-1 rounded bg-slate-900/70 p-1 leading-none text-white">
            <Video size={12} aria-hidden />
            <span className="sr-only">動画</span>
          </span>
        )}
      </div>
      <p
        className={"mt-1 text-[11px] leading-tight line-clamp-2 " + (asset.inDossier ? "text-slate-400" : "text-slate-600")}
        title={asset.title}
      >
        {asset.title}
      </p>
    </li>
  );
}

/** グループの読み上げ名 (ブログは題、トーク / その他は種別ラベル) */
function groupName(g: CandidateGroup): string {
  return g.title || MEETGREET_CANDIDATE_GROUP_LABELS[g.kind];
}
