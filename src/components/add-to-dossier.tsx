"use client";

import { useState, useTransition, useRef, useEffect, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Plus, Check, Loader2, FolderSearch, X, History } from "lucide-react";
import {
  addAssetToDossierAction,
  createDossierWithAssetAction,
  removeAssetFromDossierAction,
} from "@/app/(main)/dossiers/actions";
import {
  fetchContainingDossiers,
  markContaining,
  rememberCreatedDossier,
  rememberDossier,
  usePickerState,
  withCreated,
  type ContainingDossier,
} from "@/components/dossier-picker-store";

/** パネルの実寸。位置計算に使うので Tailwind のクラスと揃えること。 */
const PANEL_WIDTH = 256; // w-64
const PANEL_MAX_HEIGHT = 380; // 「入っている企画」と「前回の追加先」の分だけ高め
const VIEWPORT_MARGIN = 8;
/** これより狭い画面 (スマホ) では、トリガーに付けたパネルでなく画面中央のポップアップで出す */
const SHEET_MEDIA = "(max-width: 767px)";

interface EditableDossier {
  id: string;
  title: string;
}

interface AddToDossierProps {
  assetId: string;
  dossiers: EditableDossier[];
  /** Item caption to record on creation (usually asset.title). */
  defaultCaption?: string;
  /** Optional excerpt payload — used by the in-source range-selection flow. */
  excerpt?: {
    text: string;
    textType?: string;
    textStart?: number;
    textEnd?: number;
  };
  /** "icon" renders a compact + button; "button" renders a labelled button. */
  variant?: "icon" | "button";
  /** Optional ids of dossiers that already contain this asset (rendered greyed out). */
  alreadyAdded?: string[];
  /** Visual size of the trigger. */
  size?: "sm" | "md";
  /** Called after an asset is successfully added to an existing dossier. */
  onAdded?: (dossierId: string, dossierTitle: string) => void;
  /**
   * 追加済みのドシエをもう一度押すと外せるようにする (アセット詳細用)。
   * 抜粋ごとのアイテムもまとめて消えるので、抜粋フローでは有効にしない
   */
  allowRemove?: boolean;
}

export function AddToDossier({
  assetId,
  dossiers,
  defaultCaption,
  excerpt,
  variant = "icon",
  alreadyAdded = [],
  size = "sm",
  onAdded,
  allowRemove = false,
}: AddToDossierProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set(alreadyAdded));
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [isPending, startTransition] = useTransition();
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  // 開いたときの画面幅で決める (開いている間に切り替えない)
  const [sheet, setSheet] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  // このアセットが入っている企画。開くたびに引く (null = 確認中)
  const [containing, setContaining] = useState<ContainingDossier[] | null>(null);
  const { lastUsed, created } = usePickerState();
  const list = withCreated(dossiers, created);
  const isExcerpt = !!excerpt;

  // トリガーがビューポート端にあってもパネルが画面外に出ないよう、
  // 実際の位置を測って上下反転・左右クランプする。
  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - VIEWPORT_MARGIN;
    const openUpward = spaceBelow < Math.min(PANEL_MAX_HEIGHT, spaceAbove);
    const maxHeight = Math.max(160, Math.min(PANEL_MAX_HEIGHT, openUpward ? spaceAbove : spaceBelow));

    // 既定はトリガーの右端揃え。はみ出す場合だけ画面内に寄せる。
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.right - PANEL_WIDTH),
      window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN
    );
    const top = openUpward ? rect.top - 4 - maxHeight : rect.bottom + 4;
    setPosition({ top, left, maxHeight });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    setSheet(window.matchMedia(SHEET_MEDIA).matches);
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setContaining(null);
    fetchContainingDossiers(assetId, { fresh: true })
      .then((rows) => {
        if (cancelled) return;
        setContaining(rows);
        // 抜粋は入っている企画にも重ねて足せるので、押せなくはしない
        if (!isExcerpt) setAddedIds((prev) => new Set([...prev, ...rows.map((r) => r.id)]));
      })
      // 引けなくても追加はできる。「入っている企画」の欄を出さないだけ
      .catch(() => !cancelled && setContaining([]));
    return () => {
      cancelled = true;
    };
  }, [open, assetId, isExcerpt]);

  useEffect(() => {
    if (!open) return;
    function handleDown(e: MouseEvent) {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      // 背景は onClick で閉じる。ここで閉じると背景が先に消え、続く click が下のリンクに落ちる
      if (backdropRef.current?.contains(target)) return;
      setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    // スクロール/リサイズで位置がずれるので追従させる（capture でネストしたスクロールも拾う）
    document.addEventListener("mousedown", handleDown);
    document.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      document.removeEventListener("mousedown", handleDown);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, updatePosition]);

  function noteAdded(dossier: { id: string; title: string }) {
    setAddedIds((prev) => new Set(prev).add(dossier.id));
    setContaining((prev) => {
      if (!prev) return prev;
      const row = prev.find((r) => r.id === dossier.id);
      if (!row) return [{ ...dossier, itemCount: 1 }, ...prev];
      // 抜粋は同じ企画に重ねて入るので件数を進める
      return isExcerpt ? prev.map((r) => (r === row ? { ...r, itemCount: r.itemCount + 1 } : r)) : prev;
    });
    markContaining(assetId, dossier, true);
    rememberDossier(dossier);
  }

  function addToExisting(dossierId: string) {
    if (addedIds.has(dossierId)) return;
    const target = list.find((d) => d.id === dossierId);
    setPendingId(dossierId);
    setError(null);
    startTransition(async () => {
      try {
        await addAssetToDossierAction(dossierId, assetId, {
          caption: defaultCaption,
          excerpt: excerpt?.text,
          excerptType: excerpt?.textType as never,
          excerptStart: excerpt?.textStart,
          excerptEnd: excerpt?.textEnd,
        });
        noteAdded({ id: dossierId, title: target?.title ?? "" });
        if (onAdded) {
          onAdded(dossierId, target?.title || "(無題)");
          setOpen(false);
        }
      } catch (e) {
        // 投げたままにするとエラー境界まで上がってページごと落ちる
        setError(e instanceof Error ? e.message : "追加できませんでした");
      } finally {
        setPendingId(null);
      }
    });
  }

  function removeFrom(dossierId: string) {
    const target = list.find((d) => d.id === dossierId);
    if (!confirm(`「${target?.title || "(無題)"}」からこのアセットを外しますか？\n(抜粋として複数回入っている場合はすべて外れます)`)) return;
    setPendingId(dossierId);
    setError(null);
    startTransition(async () => {
      try {
        await removeAssetFromDossierAction(dossierId, assetId);
        setAddedIds((prev) => {
          const next = new Set(prev);
          next.delete(dossierId);
          return next;
        });
        setContaining((prev) => prev?.filter((r) => r.id !== dossierId) ?? prev);
        markContaining(assetId, { id: dossierId, title: target?.title ?? "" }, false);
      } catch (e) {
        setError(e instanceof Error ? e.message : "外せませんでした");
      } finally {
        setPendingId(null);
      }
    });
  }

  function createAndAdd(title: string) {
    if (!title.trim()) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await createDossierWithAssetAction(title.trim(), assetId, {
          caption: defaultCaption,
          excerpt: excerpt?.text,
          excerptType: excerpt?.textType as never,
          excerptStart: excerpt?.textStart,
          excerptEnd: excerpt?.textEnd,
        });
        const dossier = { id: result.dossierId, title: result.title };
        rememberCreatedDossier(dossier);
        noteAdded(dossier);
        setNewTitle("");
        setQuery("");
        setCreating(false);
        if (onAdded) {
          onAdded(result.dossierId, result.title);
          setOpen(false);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "作成できませんでした");
      }
    });
  }

  const trimmedQuery = query.trim();
  // 前回の追加先は、検索していないときだけ一番上に固定する (続けて同じ企画に入れるため)
  const pinned = !query && lastUsed ? (list.find((d) => d.id === lastUsed.id) ?? null) : null;
  const filtered = query
    ? list.filter((d) => d.title.toLowerCase().includes(query.toLowerCase()))
    : list.filter((d) => d.id !== pinned?.id);

  // 検索欄に入れた名前が既存のドシエと一致しなければ、そのまま作れるようにする
  const hasExactMatch = list.some(
    (d) => d.title.trim().toLowerCase() === trimmedQuery.toLowerCase()
  );
  const canQuickCreate = trimmedQuery.length > 0 && !hasExactMatch;
  // 入っている企画を確かめるまでは追加させない (入っている企画に足すとキャプションを上書きしてしまう)
  const checking = containing === null && !isExcerpt;

  function renderRow(d: { id: string; title: string }) {
    const added = addedIds.has(d.id);
    const removable = added && allowRemove;
    return (
      <li key={d.id}>
        <button
          type="button"
          onClick={() => (removable ? removeFrom(d.id) : addToExisting(d.id))}
          disabled={(added && !removable) || isPending || checking}
          title={removable ? "押すとこの企画から外す" : undefined}
          className={`group w-full text-left flex items-center justify-between gap-2 px-2 py-1.5 rounded text-xs ${
            removable
              ? "text-slate-500 hover:bg-red-50 hover:text-red-700"
              : added
                ? "text-slate-400 cursor-default"
                : "text-slate-700 hover:bg-indigo-50"
          }`}
        >
          <span className="truncate">{d.title || "(無題)"}</span>
          {pendingId === d.id ? (
            <Loader2 className="h-3 w-3 animate-spin shrink-0" />
          ) : removable ? (
            <>
              <Check className="h-3 w-3 text-emerald-500 shrink-0 group-hover:hidden" />
              <X className="h-3 w-3 shrink-0 hidden group-hover:block" />
            </>
          ) : added ? (
            <Check className="h-3 w-3 text-emerald-500 shrink-0" />
          ) : null}
        </button>
      </li>
    );
  }

  const trigger =
    variant === "button" ? (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs border border-slate-300 hover:bg-slate-50"
      >
        <FolderSearch className="h-3.5 w-3.5" /> 企画に追加
      </button>
    ) : (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="企画に追加"
        className={`inline-flex items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 hover:text-indigo-600 hover:border-indigo-300 shadow-sm ${
          size === "md" ? "w-7 h-7" : "w-6 h-6"
        }`}
      >
        <Plus className={size === "md" ? "h-4 w-4" : "h-3.5 w-3.5"} />
      </button>
    );

  // ポータルに出す理由: 親の overflow / stacking context に切り取られないようにするため。
  // position: fixed なので、位置が確定するまでは描画しない。
  // data-picker-panel: ポータル先では DOM 上の親子関係が切れるため、呼び出し元
  // （アセット本文の引用フローター等）が「自分の中のクリック」と判定できるようにする。
  const panelBody = open && position && (
    <div
      ref={panelRef}
      data-picker-panel
      // スマホは画面の上寄りに出す (下に出すと検索欄をタップしたときキーボードに隠れる)
      style={sheet ? undefined : {
        top: position.top,
        left: position.left,
        width: PANEL_WIDTH,
        maxHeight: position.maxHeight,
      }}
      className={`fixed z-50 flex flex-col overflow-hidden bg-white text-slate-700 border border-slate-200 rounded-lg shadow-lg ${
        sheet ? "inset-x-3 top-[8dvh] max-h-[70dvh] p-3 text-sm" : "p-2"
      }`}
    >
      {!creating ? (
        <>
          {sheet && (
            <div className="mb-2 flex shrink-0 items-center justify-between">
              <p className="text-sm font-semibold text-slate-700">企画に追加</p>
              <button type="button" onClick={() => setOpen(false)} className="p-1 text-slate-400 hover:text-slate-600" aria-label="閉じる">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          <input
            // スマホで開いた途端にキーボードが出ると、入っている企画・前回の追加先が隠れる
            autoFocus={!sheet}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // IME 変換確定の Enter で作成されないようにする。Safari は確定の Enter で
              // isComposing が false になるので keyCode 229 も見る
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              // 空欄の Enter は前回の追加先へ
              if (e.key === "Enter" && !query && pinned && !addedIds.has(pinned.id) && !isPending && !checking) {
                e.preventDefault();
                addToExisting(pinned.id);
                return;
              }
              // 一致するドシエが1つも無いなら、Enter でそのまま作成
              if (e.key === "Enter" && canQuickCreate && filtered.length === 0) {
                e.preventDefault();
                createAndAdd(trimmedQuery);
              }
            }}
            placeholder="企画を検索 / 新規作成..."
            className="w-full text-xs border border-slate-300 rounded px-2 py-1 mb-2 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <div className="mb-2 shrink-0 rounded bg-slate-50 px-2 py-1.5 text-[11px]">
            {containing === null ? (
              <span className="inline-flex items-center gap-1 text-slate-400">
                <Loader2 className="h-3 w-3 animate-spin" /> 入っている企画を確認中…
              </span>
            ) : containing.length === 0 ? (
              <span className="text-slate-400">まだどの企画にも入っていません</span>
            ) : (
              <>
                <p className="text-slate-500 mb-0.5">入っている企画</p>
                <ul className="max-h-16 overflow-y-auto space-y-0.5">
                  {containing.map((c) => (
                    <li key={c.id} className="flex items-center gap-1 min-w-0">
                      <Check className="h-3 w-3 text-emerald-500 shrink-0" />
                      <Link
                        href={`/dossiers/${c.id}`}
                        className="truncate text-slate-700 hover:text-indigo-600 hover:underline"
                      >
                        {c.title || "(無題)"}
                      </Link>
                      {c.itemCount > 1 && <span className="shrink-0 text-slate-400">×{c.itemCount}</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          {pinned && (
            <div className="mb-1 shrink-0 border-b border-slate-100 pb-1">
              <p className="flex items-center gap-1 px-2 text-[10px] text-slate-400">
                <History className="h-3 w-3" /> 前回の追加先{!addedIds.has(pinned.id) && "（Enter で追加）"}
              </p>
              <ul>{renderRow(pinned)}</ul>
            </div>
          )}
          <ul className="flex-1 min-h-0 overflow-y-auto space-y-0.5">
            {filtered.length === 0 && !canQuickCreate && (
              <li className="text-[11px] text-slate-400 px-2 py-1.5">該当なし</li>
            )}
            {filtered.map(renderRow)}
          </ul>
          {error && <p className="mt-1 shrink-0 text-[11px] text-red-600 px-2">{error}</p>}
          <div className="mt-2 shrink-0 border-t border-slate-100 pt-2">
            {canQuickCreate ? (
              <button
                type="button"
                onClick={() => createAndAdd(trimmedQuery)}
                disabled={isPending}
                className="w-full text-left text-xs text-indigo-600 hover:bg-indigo-50 rounded flex items-center gap-1 px-2 py-1.5 disabled:opacity-50"
              >
                {isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                ) : (
                  <Plus className="h-3 w-3 shrink-0" />
                )}
                <span className="truncate">
                  「{trimmedQuery}」を新規作成
                </span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="w-full text-xs text-indigo-600 hover:underline flex items-center gap-1 px-2 py-1"
              >
                <Plus className="h-3 w-3" /> 新規企画を作成
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-600">新規企画</p>
          <input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter" && newTitle.trim() && !isPending) {
                e.preventDefault();
                createAndAdd(newTitle);
              }
            }}
            placeholder="タイトル"
            className="w-full text-xs border border-slate-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <p className="text-[10px] text-slate-400">
            作成と同時に、このアセットを新しい企画に追加します。
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={() => createAndAdd(newTitle)}
              disabled={!newTitle.trim() || isPending}
              className="bg-indigo-600 text-white px-2 py-1 rounded text-xs font-medium hover:bg-indigo-700 disabled:opacity-50 inline-flex items-center gap-1"
            >
              {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
              作成して追加
            </button>
          </div>
        </div>
      )}
    </div>
  );

  const panel = panelBody && (sheet ? (
    <>
      <div
        ref={backdropRef}
        data-picker-panel
        className="fixed inset-0 z-50 bg-black/40"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }}
      />
      {panelBody}
    </>
  ) : panelBody);

  return (
    <div ref={anchorRef} className="relative inline-block">
      {trigger}
      {panel && createPortal(panel, document.body)}
    </div>
  );
}

/**
 * 前回の追加先へ 1 クリックで入れるボタン (ギャラリーの拡大表示用)。
 * ← → で送りながら同じ企画に続けて入れられるようにする。前回が無い・編集できない企画なら出さない
 */
export function QuickAddToLastDossier({
  assetId,
  dossiers,
  defaultCaption,
}: {
  assetId: string;
  dossiers: EditableDossier[];
  defaultCaption?: string;
}) {
  const { lastUsed, created, containingVersion } = usePickerState();
  const target = lastUsed ? withCreated(dossiers, created).find((d) => d.id === lastUsed.id) : undefined;
  const targetId = target?.id;
  // null = 確認中 / "unknown" = 確かめられなかった (入っていたらキャプションを上書きするので押させない)
  const [contained, setContained] = useState<boolean | "unknown" | null>(null);
  const [error, setError] = useState(false);
  const [isPending, startTransition] = useTransition();

  // ← → で送るたびに引くと、サーバーアクションが直列に積まれて追加が待たされる。
  // 止まってから引き直す (企画のページで外して戻ってきた場合もあるので fresh)
  useEffect(() => {
    if (!targetId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchContainingDossiers(assetId, { fresh: true })
        .then((rows) => !cancelled && setContained(rows.some((r) => r.id === targetId)))
        .catch(() => !cancelled && setContained("unknown"));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [assetId, targetId]);

  // ピッカー側で足し外ししたら手元のキャッシュから読み直す (通信しない)
  useEffect(() => {
    if (!targetId || containingVersion === 0) return;
    let cancelled = false;
    fetchContainingDossiers(assetId)
      .then((rows) => !cancelled && setContained(rows.some((r) => r.id === targetId)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [assetId, targetId, containingVersion]);

  if (!target) return null;
  const title = target.title || "(無題)";

  function add() {
    if (!target || contained !== false) return;
    setError(false);
    startTransition(async () => {
      try {
        await addAssetToDossierAction(target.id, assetId, { caption: defaultCaption });
        setContained(true);
        markContaining(assetId, target, true);
        rememberDossier(target);
      } catch {
        setError(true);
      }
    });
  }

  return (
    <button
      type="button"
      onClick={add}
      disabled={contained !== false || isPending}
      title={
        contained === "unknown"
          ? "入っている企画を確かめられませんでした。＋から追加してください"
          : contained
            ? `「${title}」に入っています`
            : `「${title}」に追加`
      }
      aria-live="polite"
      className={`inline-flex min-w-0 items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
        contained === true
          ? "bg-emerald-500/20 text-emerald-100"
          : "bg-indigo-500/80 text-white hover:bg-indigo-500 active:bg-indigo-600 disabled:opacity-60"
      }`}
    >
      {isPending || contained === null ? (
        <Loader2 size={16} className="shrink-0 animate-spin" />
      ) : contained === true ? (
        <Check size={16} className="shrink-0" />
      ) : (
        <Plus size={16} className="shrink-0" />
      )}
      <span className="max-w-[10rem] truncate">{title}</span>
      <span className="shrink-0">{error ? "に追加できませんでした" : contained === "unknown" ? "を確認できませんでした" : contained ? "に追加済み" : "に追加"}</span>
    </button>
  );
}
