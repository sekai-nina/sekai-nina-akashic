"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, FileText, FolderPlus, Loader2, Search, Trash2, X } from "lucide-react";
import { deleteClipsAction, moveClipsAction, updateClipNoteAction } from "./actions";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ASSET_KIND_LABELS, ENTITY_TYPE_BADGE, ENTITY_TYPE_LABELS, formatDate } from "@/lib/utils";

/**
 * クリップ一覧 (#41) の本体。
 *
 * 「共通点を見つけて 1 つの記事にまとめる」ための最小セット:
 * - エンティティチップ (人・場所・タグ・イベント) で絞り込む — 同じ人・同じ場所のクリップが並ぶ
 * - 抜粋・メモ・アセット名の文字検索
 * - 並び替え (クリップした順 / アセットの日付順)、「自分のだけ」
 * - 絞った状態で全選択 → 「ドシエにまとめる」(新規 / 既存) か削除
 *
 * データは全件を props で受け取り、絞り込みは全部クライアントで行う (プールは数百件止まり)。
 */

export interface ClipCard {
  id: string;
  excerpt: string;
  note: string;
  located: boolean;
  createdAt: string;
  createdById: string | null;
  createdBy: string | null;
  asset: {
    id: string;
    kind: string;
    title: string;
    date: string | null;
    thumbnailUrl: string | null;
    entities: { id: string; type: string; name: string }[];
  } | null;
}

interface DossierOption {
  id: string;
  title: string;
  /** 記事の素材ドシエなら、その記事タイトル (検索対象。空なら通常のドシエ) */
  articleTitles: string[];
}

interface ClipsBoardProps {
  clips: ClipCard[];
  dossiers: DossierOption[];
  currentUserId: string;
  canEdit: boolean;
}

type SortKey = "clipped" | "assetDate";

/** 最初に見せるエンティティチップの数。超えた分は「すべて表示」で開く */
const CHIPS_COLLAPSED = 16;
/** 移動先ピッカーに一度に描画する上限。超過分は検索で絞ってもらう */
const MAX_DOSSIER_OPTIONS = 100;
/** 位置未確定 (本文と一致しなかった) クリップのバッジ */
const UNLOCATED_BADGE = (
  <span className="text-[10px] px-1 rounded bg-slate-100 text-slate-500" title="本文内の位置が確定していないため、本文上のハイライトは出ません">
    位置未確定
  </span>
);

export function ClipsBoard({ clips, dossiers, currentUserId, canEdit }: ClipsBoardProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [entityId, setEntityId] = useState<string | null>(null);
  const [mineOnly, setMineOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>("clipped");
  const [showAllChips, setShowAllChips] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moveOpen, setMoveOpen] = useState(false);
  const [isDeleting, startDelete] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // 再取得で消えたクリップ (他の人が動かした等) を選択から外す。残すと「N 件選択」のまま
  // 移動が件数不一致で失敗し続ける
  useEffect(() => {
    setSelected((prev) => {
      const alive = new Set(clips.map((c) => c.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [clips]);

  // エンティティチップ: 出現回数の多い順
  const entityChips = useMemo(() => {
    const counts = new Map<string, { id: string; type: string; name: string; count: number }>();
    for (const c of clips) {
      for (const e of c.asset?.entities ?? []) {
        const cur = counts.get(e.id);
        if (cur) cur.count++;
        else counts.set(e.id, { ...e, count: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ja"));
  }, [clips]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = clips.filter((c) => {
      if (mineOnly && c.createdById !== currentUserId) return false;
      if (entityId && !c.asset?.entities.some((e) => e.id === entityId)) return false;
      if (q) {
        const hay = `${c.excerpt}\n${c.note}\n${c.asset?.title ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    if (sort === "assetDate") {
      // 日付の無いものは末尾
      filtered.sort((a, b) => {
        const da = a.asset?.date ?? "";
        const db = b.asset?.date ?? "";
        if (da === db) return b.createdAt.localeCompare(a.createdAt);
        if (!da) return 1;
        if (!db) return -1;
        return db.localeCompare(da);
      });
    }
    return filtered;
  }, [clips, query, entityId, mineOnly, sort, currentUserId]);

  const visibleIds = useMemo(() => new Set(visible.map((c) => c.id)), [visible]);
  const selectedVisible = [...selected].filter((id) => visibleIds.has(id));
  const allVisibleSelected = visible.length > 0 && selectedVisible.length === visible.length;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectAllVisible = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) for (const id of visibleIds) next.delete(id);
      else for (const id of visibleIds) next.add(id);
      return next;
    });

  const removeSelected = () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!confirm(`${ids.length} 件のクリップを削除しますか？`)) return;
    setError(null);
    startDelete(async () => {
      const result = await deleteClipsAction(ids);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSelected(new Set());
      router.refresh();
    });
  };

  if (clips.length === 0) {
    return (
      <div className="bg-white border border-dashed border-slate-300 rounded-lg p-8 text-center">
        <p className="text-sm text-slate-500">クリップはまだありません</p>
        <p className="text-xs text-slate-400 mt-1">
          アセット詳細の「クリップ」ボタンか、本文を選択して出るフローターから取っておけます
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* 絞り込み */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center mb-3">
        <label className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="抜粋・メモ・アセット名で絞り込む"
            className="w-full pl-8 pr-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
          />
        </label>
        <div className="flex items-center gap-2 text-xs">
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="px-2 py-2 border border-slate-200 rounded-lg bg-white"
          >
            <option value="clipped">クリップした順</option>
            <option value="assetDate">アセットの日付順</option>
          </select>
          <label className="inline-flex items-center gap-1.5 px-2 py-2 border border-slate-200 rounded-lg bg-white cursor-pointer">
            <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
            自分のだけ
          </label>
        </div>
      </div>

      {entityChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          {(showAllChips ? entityChips : entityChips.slice(0, CHIPS_COLLAPSED)).map((e) => {
            const active = entityId === e.id;
            return (
              <button
                key={e.id}
                type="button"
                onClick={() => setEntityId(active ? null : e.id)}
                title={ENTITY_TYPE_LABELS[e.type] ?? e.type}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border transition-colors ${
                  ENTITY_TYPE_BADGE[e.type] ?? ENTITY_TYPE_BADGE.tag
                } ${active ? "ring-2 ring-indigo-400 ring-offset-1" : "hover:brightness-95"}`}
              >
                {e.name}
                <span className="opacity-60">{e.count}</span>
              </button>
            );
          })}
          {entityChips.length > CHIPS_COLLAPSED && (
            <button
              type="button"
              onClick={() => setShowAllChips((v) => !v)}
              className="text-[11px] text-indigo-600 hover:underline px-1"
            >
              {showAllChips ? "折りたたむ" : `他 ${entityChips.length - CHIPS_COLLAPSED} 件を表示`}
            </button>
          )}
          {entityId && (
            <button
              type="button"
              onClick={() => setEntityId(null)}
              className="inline-flex items-center gap-0.5 text-[11px] text-slate-500 hover:text-slate-800 px-1"
            >
              <X className="h-3 w-3" /> 絞り込み解除
            </button>
          )}
        </div>
      )}

      {/* 件数と全選択 */}
      <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
        <span>
          {visible.length} 件{visible.length !== clips.length && <> / 全 {clips.length} 件</>}
        </span>
        {canEdit && visible.length > 0 && (
          <button type="button" onClick={selectAllVisible} className="text-indigo-600 hover:underline">
            {allVisibleSelected ? "選択を解除" : "表示中をすべて選択"}
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-lg p-6 text-center text-sm text-slate-500">
          条件に合うクリップはありません
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {visible.map((c) => (
            <ClipCardView
              key={c.id}
              clip={c}
              canEdit={canEdit}
              selected={selected.has(c.id)}
              onToggle={() => toggle(c.id)}
              onEntityClick={(id) => setEntityId((cur) => (cur === id ? null : id))}
            />
          ))}
        </ul>
      )}

      {/* 選択中の操作バー */}
      {canEdit && selected.size > 0 && (
        // スマホでは右下の＋ (QuickCreateModal の FAB, bottom-4) と重ならない高さに置く
        <div className="sticky bottom-20 md:bottom-3 mt-4 z-30">
          <div className="mx-auto max-w-2xl bg-slate-900 text-white rounded-xl shadow-lg px-4 py-2.5 flex items-center gap-3 flex-wrap">
            <span className="text-sm font-medium">{selected.size} 件選択</span>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-xs text-white/70 hover:text-white"
            >
              解除
            </button>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={removeSelected}
                disabled={isDeleting}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-white/30 hover:bg-white/10 disabled:opacity-50"
              >
                {isDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                削除
              </button>
              <button
                type="button"
                onClick={() => setMoveOpen(true)}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-sky-500 hover:bg-sky-400"
              >
                <FolderPlus className="h-3.5 w-3.5" />
                ドシエにまとめる
              </button>
            </div>
            {error && <p className="w-full text-xs text-red-300">{error}</p>}
          </div>
        </div>
      )}

      <MoveDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        itemIds={[...selected]}
        dossiers={dossiers}
        onMoved={() => {
          setSelected(new Set());
          router.refresh();
        }}
      />
    </div>
  );
}

// ============================================================
// カード
// ============================================================

function ClipCardView({
  clip,
  canEdit,
  selected,
  onToggle,
  onEntityClick,
}: {
  clip: ClipCard;
  canEdit: boolean;
  selected: boolean;
  onToggle: () => void;
  onEntityClick: (entityId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(clip.note);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [isSaving, startSave] = useTransition();
  const router = useRouter();

  const saveNote = () => {
    setNoteError(null);
    startSave(async () => {
      const result = await updateClipNoteAction(clip.id, noteDraft);
      if (!result.ok) {
        setNoteError(result.error);
        return;
      }
      setEditingNote(false);
      router.refresh();
    });
  };

  /** line-clamp-5 で切れるおおよその長さ。超えたら「全文を表示」を出す */
  const LONG_EXCERPT = 160;

  return (
    <li
      className={`bg-white border rounded-lg p-3.5 flex gap-3 transition-colors ${
        selected ? "border-sky-400 ring-1 ring-sky-300" : "border-slate-200"
      }`}
    >
      {canEdit && (
        <label className="pt-0.5 shrink-0 cursor-pointer">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            aria-label={`「${clip.asset?.title ?? "クリップ"}」を選択`}
            className="h-4 w-4"
          />
        </label>
      )}
      <div className="min-w-0 flex-1">
        {clip.excerpt && (
          <>
            {/* 引用は記事に写す文字列なので、選択・コピーできる要素で出す (button だと選べない) */}
            <blockquote
              className={`text-sm text-slate-800 whitespace-pre-wrap border-l-2 border-sky-300 pl-2.5 ${
                expanded ? "" : "line-clamp-5"
              }`}
            >
              {clip.excerpt}
            </blockquote>
            <div className="mt-1 flex items-center gap-2">
              {!clip.located && UNLOCATED_BADGE}
              {clip.excerpt.length > LONG_EXCERPT && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="text-[11px] text-indigo-600 hover:underline"
                >
                  {expanded ? "折りたたむ" : "全文を表示"}
                </button>
              )}
            </div>
          </>
        )}

        {editingNote ? (
          <div className="mt-2">
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              rows={3}
              autoFocus
              aria-label="メモ"
              className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") saveNote();
              }}
            />
            {noteError && <p className="mt-1 text-xs text-red-600">{noteError}</p>}
            <div className="mt-1 flex items-center gap-2 justify-end">
              <button
                type="button"
                onClick={() => {
                  setEditingNote(false);
                  setNoteDraft(clip.note);
                  setNoteError(null);
                }}
                className="text-xs text-slate-500 hover:text-slate-800"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={saveNote}
                disabled={isSaving}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-slate-900 text-white disabled:opacity-50"
              >
                {isSaving && <Loader2 className="h-3 w-3 animate-spin" />}
                保存
              </button>
            </div>
          </div>
        ) : clip.note ? (
          canEdit ? (
            <button
              type="button"
              onClick={() => setEditingNote(true)}
              title="メモを編集"
              className={`block w-full text-left text-sm text-slate-600 whitespace-pre-wrap rounded hover:bg-slate-50 ${
                clip.excerpt ? "mt-2" : ""
              }`}
            >
              {clip.note}
            </button>
          ) : (
            <p className={`text-sm text-slate-600 whitespace-pre-wrap ${clip.excerpt ? "mt-2" : ""}`}>{clip.note}</p>
          )
        ) : canEdit ? (
          <button
            type="button"
            onClick={() => setEditingNote(true)}
            className="mt-2 text-[11px] text-slate-400 hover:text-slate-700"
          >
            + メモを書く
          </button>
        ) : null}

        <div className="mt-2.5 flex items-start gap-2">
          {clip.asset?.thumbnailUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={clip.asset.thumbnailUrl}
              alt=""
              className="w-10 h-10 rounded object-cover border border-slate-200 shrink-0"
              loading="lazy"
            />
          )}
          <div className="min-w-0 flex-1 text-xs">
            {clip.asset ? (
              <Link href={`/assets/${clip.asset.id}`} className="text-indigo-700 hover:underline break-words">
                {clip.asset.title}
              </Link>
            ) : (
              <span className="text-slate-400">(アセットが見つかりません)</span>
            )}
            <div className="text-[11px] text-slate-400 mt-0.5">
              {clip.asset && <>{ASSET_KIND_LABELS[clip.asset.kind] ?? clip.asset.kind}</>}
              {clip.asset?.date && <> ・ {formatDate(clip.asset.date)}</>}
            </div>
            {clip.asset && clip.asset.entities.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {clip.asset.entities.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => onEntityClick(e.id)}
                    title={`「${e.name}」で絞り込む`}
                    className={`px-1.5 py-0.5 rounded-full text-[10px] border ${ENTITY_TYPE_BADGE[e.type] ?? ENTITY_TYPE_BADGE.tag} hover:brightness-95`}
                  >
                    {e.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="mt-2 text-[10px] text-slate-400">
          {formatDate(clip.createdAt, true)}
          {clip.createdBy && <> ・ {clip.createdBy}</>}
        </div>
      </div>
    </li>
  );
}

// ============================================================
// ドシエにまとめる
// ============================================================

function MoveDialog({
  open,
  onOpenChange,
  itemIds,
  dossiers,
  onMoved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemIds: string[];
  dossiers: DossierOption[];
  onMoved: () => void;
}) {
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [query, setQuery] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ dossierId: string; title: string; moved: number } | null>(null);
  /** 送信中の移動先 (既存ならその id、新規なら "new") */
  const [pending, setPending] = useState<{ kind: "dossier"; id: string } | { kind: "new" } | null>(null);
  const [isPending, startTransition] = useTransition();

  // ドシエ名に加えて記事名でも探せる (素材ドシエはタイトル = 作成時の記事名で、記事側が改名されていることがある)
  const q = query.trim().toLowerCase();
  const filtered = q
    ? dossiers.filter(
        (d) => d.title.toLowerCase().includes(q) || d.articleTitles.some((t) => t.toLowerCase().includes(q))
      )
    : dossiers;

  const close = (next: boolean) => {
    if (!next) {
      setError(null);
      setResult(null);
      setPending(null);
      setQuery("");
      setNewTitle("");
    }
    onOpenChange(next);
  };

  const move = (target: { kind: "dossier"; dossierId: string; title: string } | { kind: "new"; title: string }) => {
    if (isPending) return;
    setError(null);
    setPending(target.kind === "dossier" ? { kind: "dossier", id: target.dossierId } : { kind: "new" });
    startTransition(async () => {
      const res = await moveClipsAction(
        itemIds,
        target.kind === "dossier" ? { kind: "dossier", dossierId: target.dossierId } : { kind: "new", title: target.title }
      );
      setPending(null);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setResult({ dossierId: res.dossierId, title: target.title, moved: res.moved });
      onMoved();
    });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md mx-4 max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">
            {result ? result.moved : itemIds.length} 件をドシエにまとめる
          </DialogTitle>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              {result.moved} 件を「{result.title}」に移しました
            </p>
            <div className="flex items-center justify-end gap-2">
              <Link href={`/dossiers/${result.dossierId}`} className="text-sm text-indigo-600 hover:underline">
                ドシエを開く →
              </Link>
              <button
                type="button"
                onClick={() => close(false)}
                className="px-3 py-1.5 text-sm rounded border border-slate-300 hover:bg-slate-50"
              >
                閉じる
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-1 border-b border-slate-200 text-sm">
              {(
                [
                  ["existing", "既存のドシエ"],
                  ["new", "新しいドシエ"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setMode(key)}
                  className={`px-3 py-1.5 -mb-px border-b-2 ${
                    mode === key ? "border-sky-600 text-sky-700 font-medium" : "border-transparent text-slate-500 hover:text-slate-800"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {mode === "existing" ? (
              <div>
                <input
                  autoFocus
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="ドシエ名・記事名で検索"
                  className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded"
                />
                <ul className="mt-2 max-h-72 overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded">
                  {filtered.length === 0 && (
                    <li className="px-3 py-4 text-center text-xs text-slate-400">
                      該当なし
                      {q !== "" && (
                        <span className="block mt-1">
                          記事の素材ドシエが無いときは、記事詳細の「素材ドシエを作る」で作ってから
                        </span>
                      )}
                    </li>
                  )}
                  {filtered.slice(0, MAX_DOSSIER_OPTIONS).map((d) => (
                    <li key={d.id}>
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => move({ kind: "dossier", dossierId: d.id, title: d.title })}
                        className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-slate-50 disabled:opacity-60"
                      >
                        {pending?.kind === "dossier" && pending.id === d.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                        ) : (
                          <span className="w-3.5 shrink-0" />
                        )}
                        <span className="truncate flex-1">{d.title || "(無題)"}</span>
                        {d.articleTitles.length > 0 && (
                          <span
                            className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 shrink-0"
                            title="記事の素材ドシエ"
                          >
                            <FileText className="h-3 w-3" /> 記事
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                  {filtered.length > MAX_DOSSIER_OPTIONS && (
                    <li className="px-3 py-2 text-center text-xs text-slate-400">
                      他 {filtered.length - MAX_DOSSIER_OPTIONS} 件 — 検索で絞り込んでください
                    </li>
                  )}
                </ul>
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (newTitle.trim()) move({ kind: "new", title: newTitle.trim() });
                }}
                className="space-y-2"
              >
                <input
                  autoFocus
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="ドシエのタイトル (あとで記事名になる想定で)"
                  className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded"
                />
                <p className="text-[11px] text-slate-400">
                  共有設定は非公開で作ります。ドシエの画面から変えられます
                </p>
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={isPending || newTitle.trim() === ""}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
                  >
                    {pending?.kind === "new" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    作って移す
                  </button>
                </div>
              </form>
            )}

            {error && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded px-2 py-1.5">{error}</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
