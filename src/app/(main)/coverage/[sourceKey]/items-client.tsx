"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, ExternalLink, FileText, Undo2, X } from "lucide-react";
import type { ItemDTO } from "@/lib/domain/coverage";
import type { ItemRule } from "@prisma/client";
import { toggleCheckAction, bulkCheckAction, setItemChecksAction } from "../actions";

interface SourceMeta {
  key: string;
  name: string;
  itemRule: ItemRule;
  totalItems: number;
  public: boolean;
  mentionApplicable: boolean;
}

interface LensMeta {
  key: string;
  name: string;
}

type Progress = { checked: number; total: number; continuousUntil: string | null };
type Mode = "digest" | "lens";

/** Undo トースト: 直前の「行が消えた」操作（そのとき✓した観点群） */
interface UndoState {
  itemKey: string;
  itemTitle: string;
  lensKeys: string[];
}

/** ライトボックス: 行の画像アセット列と現在位置 */
interface LightboxState {
  images: { id: string }[];
  index: number;
  title: string;
}

function thumbUrl(assetId: string): string {
  return `/api/v1/assets/${assetId}/thumbnail`;
}

export function ItemListClient({
  source,
  lenses,
  lensProgress,
  selectedLensKey,
  items: initialItems,
  mode,
  order,
  page,
  pageSize,
  total,
  mentionOn,
  canEdit,
}: {
  source: SourceMeta;
  lenses: LensMeta[];
  lensProgress: Record<string, Progress>;
  selectedLensKey: string | null;
  items: ItemDTO[];
  mode: Mode;
  order: "asc" | "desc";
  page: number;
  pageSize: number;
  total: number;
  mentionOn: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  // 楽観更新用のローカルコピー（props が変われば同期）
  const [items, setItems] = useState<ItemDTO[]>(initialItems);
  const [progress, setProgress] = useState<Record<string, Progress>>(lensProgress);
  useEffect(() => setItems(initialItems), [initialItems]);
  useEffect(() => setProgress(lensProgress), [lensProgress]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showCompleted, setShowCompleted] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const sel = selectedLensKey;
  const selProgress = sel ? progress[sel] : undefined;

  // ============================================================
  // ナビゲーション（URL パラメータ: mode / lens / order / mentions / page）
  // ============================================================

  function nav(next: {
    mode?: Mode;
    lens?: string;
    order?: "asc" | "desc";
    page?: number;
    mentions?: boolean;
  }) {
    const p = new URLSearchParams();
    p.set("mode", next.mode ?? mode);
    p.set("lens", next.lens ?? sel ?? "");
    p.set("order", next.order ?? order);
    const nextMentions = next.mentions ?? mentionOn;
    if (source.mentionApplicable) p.set("mentions", nextMentions ? "1" : "0");
    if (next.page && next.page > 1) p.set("page", String(next.page));
    router.push(`/coverage/${source.key}?${p.toString()}`);
  }

  // ============================================================
  // チェック状態ヘルパー
  // ============================================================

  function checkedKeys(item: ItemDTO): string[] {
    return item.checkedLensKeys ?? [];
  }

  function isChecked(item: ItemDTO, lensKey: string): boolean {
    return checkedKeys(item).includes(lensKey);
  }

  /** 行の完了 = 全アクティブ観点に✓（消化モードの消える条件） */
  function isComplete(item: ItemDTO): boolean {
    const set = new Set(checkedKeys(item));
    return lenses.length > 0 && lenses.every((l) => set.has(l.key));
  }

  /** このモードで「行が消える」状態か */
  function isDone(item: ItemDTO): boolean {
    if (mode === "lens") return sel ? isChecked(item, sel) : false;
    return isComplete(item);
  }

  function setLocalChecked(itemKey: string, lensKeys: string[], checked: boolean) {
    setItems((prev) =>
      prev.map((it) => {
        if (it.itemKey !== itemKey) return it;
        const set = new Set(it.checkedLensKeys ?? []);
        for (const k of lensKeys) {
          if (checked) set.add(k);
          else set.delete(k);
        }
        return { ...it, checkedLensKeys: [...set] };
      })
    );
    setProgress((prev) => {
      const next = { ...prev };
      for (const k of lensKeys) {
        const cur = next[k];
        if (!cur) continue;
        const delta = checked ? 1 : -1;
        next[k] = { ...cur, checked: Math.max(0, Math.min(cur.total, cur.checked + delta)) };
      }
      return next;
    });
  }

  // ============================================================
  // Undo トースト
  // ============================================================

  function pushUndo(u: UndoState) {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(u);
    undoTimer.current = setTimeout(() => setUndo(null), 8000);
  }

  async function performUndo() {
    if (!undo) return;
    const u = undo;
    setUndo(null);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setLocalChecked(u.itemKey, u.lensKeys, false); // 楽観（行が復活する）
    const res = await setItemChecksAction({
      dataSourceKey: source.key,
      itemKey: u.itemKey,
      lensKeys: u.lensKeys,
      checked: false,
    });
    if (!res.ok) {
      setLocalChecked(u.itemKey, u.lensKeys, true);
      setMsg(`エラー: ${res.error}`);
    }
  }

  // ============================================================
  // チェック操作
  // ============================================================

  /** 単一観点のトグル（消化モードのチップ / 観点モードのチェックボックス） */
  async function toggle(item: ItemDTO, lensKey: string, checked: boolean) {
    if (!canEdit) return;
    setMsg(null);
    const wasDone = isDone(item);
    setLocalChecked(item.itemKey, [lensKey], checked); // 楽観

    // この操作で行が消えるなら Undo を積む
    if (checked && !wasDone && !showCompleted) {
      const after = new Set([...checkedKeys(item), lensKey]);
      const nowDone =
        mode === "lens" ? lensKey === sel : lenses.every((l) => after.has(l.key));
      if (nowDone) {
        pushUndo({
          itemKey: item.itemKey,
          itemTitle: item.itemTitle || item.itemKey,
          lensKeys: [lensKey],
        });
      }
    }

    const res = await toggleCheckAction({
      lensKey,
      dataSourceKey: source.key,
      itemKey: item.itemKey,
      checked,
    });
    if (!res.ok) {
      setLocalChecked(item.itemKey, [lensKey], !checked); // 失敗したら戻す
      setMsg(`エラー: ${res.error}`);
    }
  }

  /** 消化モード:「残りの観点は該当なし」= 未チェック観点を一括✓して行を完了 */
  async function checkRemaining(item: ItemDTO) {
    if (!canEdit) return;
    const set = new Set(checkedKeys(item));
    const remaining = lenses.filter((l) => !set.has(l.key)).map((l) => l.key);
    if (remaining.length === 0) return;
    setMsg(null);
    setLocalChecked(item.itemKey, remaining, true); // 楽観（行が消える）
    if (!showCompleted) {
      pushUndo({
        itemKey: item.itemKey,
        itemTitle: item.itemTitle || item.itemKey,
        lensKeys: remaining,
      });
    }
    const res = await setItemChecksAction({
      dataSourceKey: source.key,
      itemKey: item.itemKey,
      lensKeys: remaining,
      checked: true,
    });
    if (!res.ok) {
      setLocalChecked(item.itemKey, remaining, false);
      setUndo(null);
      setMsg(`エラー: ${res.error}`);
    }
  }

  /** 範囲一括（ここまで全部✓ / 言及なしをここまで✓） */
  async function bulk(item: ItemDTO, scope: "one" | "all", onlyMentionless = false) {
    if (!canEdit || !item.itemDate) return;
    const lensKeys = scope === "one" ? (sel ? [sel] : []) : lenses.map((l) => l.key);
    if (lensKeys.length === 0) return;
    const label =
      scope === "one" ? `「${lenses.find((l) => l.key === sel)?.name ?? sel}」` : "全観点";
    const kind = onlyMentionless ? "言及なしの全アイテム" : "全アイテム";
    if (
      !confirm(
        `${item.itemDate} 以前の${kind}（${source.name}）を ${label} でチェック済みにします。よろしいですか？`
      )
    )
      return;
    setMsg(null);
    const res = await bulkCheckAction({
      dataSourceKey: source.key,
      lensKeys,
      untilDate: item.itemDate,
      onlyMentionless,
    });
    if (!res.ok) {
      setMsg(`エラー: ${res.error}`);
    } else {
      setMsg(
        `${label}${onlyMentionless ? "・言及なし" : ""}: ${res.result.created} 件をチェック済みにしました`
      );
      startTransition(() => router.refresh());
    }
  }

  /** ヘッダの「言及なしを全部✓」（全期間・全観点・ワンショット） */
  async function bulkAllMentionless() {
    if (!canEdit) return;
    if (
      !confirm(
        `${source.name} の坂井新奈への言及がない全アイテム（全期間）を、全観点でチェック済みにします。よろしいですか？`
      )
    )
      return;
    setMsg(null);
    const res = await bulkCheckAction({
      dataSourceKey: source.key,
      lensKeys: lenses.map((l) => l.key),
      onlyMentionless: true,
    });
    if (!res.ok) {
      setMsg(`エラー: ${res.error}`);
    } else {
      setMsg(`言及なし（全期間・全観点）: ${res.result.created} 件をチェック済みにしました`);
      startTransition(() => router.refresh());
    }
  }

  // ============================================================
  // 表示行（消えた行の除外・完了済み表示トグル）
  // ============================================================

  const visibleItems = useMemo(() => {
    if (showCompleted) return items;
    return items.filter((it) => !isDone(it));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, showCompleted, mode, sel, lenses]);

  const remainingCount = useMemo(
    () => items.filter((it) => !isDone(it)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, mode, sel, lenses]
  );

  // ============================================================
  // ライトボックス（Esc / ←→ キー操作）
  // ============================================================

  useEffect(() => {
    if (!lightbox) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setLightbox(null);
      if (e.key === "ArrowRight")
        setLightbox((lb) =>
          lb && lb.index < lb.images.length - 1 ? { ...lb, index: lb.index + 1 } : lb
        );
      if (e.key === "ArrowLeft")
        setLightbox((lb) => (lb && lb.index > 0 ? { ...lb, index: lb.index - 1 } : lb));
    }
    document.addEventListener("keydown", handleKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = "";
    };
  }, [lightbox]);

  // ============================================================
  // レンダリング
  // ============================================================

  return (
    <div>
      <div className="mb-4">
        <Link href="/coverage" className="text-xs text-slate-500 hover:text-slate-700">
          ← 収集カバレッジ
        </Link>
        <h1 className="text-2xl font-bold text-slate-900 mt-1">
          {source.name}
          {!source.public && <span className="ml-2 text-xs text-slate-400">(非公開)</span>}
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          導出アイテム {source.totalItems} 件（{source.itemRule}）。
          {!canEdit && "（閲覧のみ）"}
        </p>
      </div>

      {source.totalItems === 0 ? (
        <p className="text-slate-400 py-8 text-center text-sm">
          このソースには導出アイテムがありません（itemRule={source.itemRule}）。
          「観点・ソース管理」タブで導出規則を設定してください。
        </p>
      ) : (
        <>
          {/* モード切替 */}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden text-sm">
              <button
                onClick={() => nav({ mode: "digest", page: 1 })}
                className={`px-3 py-1.5 font-medium ${
                  mode === "digest"
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                消化モード
              </button>
              <button
                onClick={() => nav({ mode: "lens", page: 1 })}
                className={`px-3 py-1.5 font-medium ${
                  mode === "lens" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                観点モード
              </button>
            </div>
            {mode === "digest" && (
              <span className="text-xs text-slate-400">
                読んだら関係する観点に✓。全観点✓で行が消えます
              </span>
            )}
          </div>

          {/* 観点タブ（観点モードのみ） */}
          {mode === "lens" && (
            <div className="flex flex-wrap gap-1 mb-3 border-b border-slate-200">
              {lenses.map((l) => {
                const pg = progress[l.key];
                const active = l.key === sel;
                return (
                  <button
                    key={l.key}
                    onClick={() => nav({ lens: l.key, page: 1 })}
                    className={`px-3 py-2 text-sm font-medium -mb-px border-b-2 ${
                      active
                        ? "border-slate-900 text-slate-900"
                        : "border-transparent text-slate-500 hover:text-slate-700"
                    }`}
                  >
                    {l.name}
                    {pg && (
                      <span className="ml-1.5 text-[11px] tabular-nums text-slate-400">
                        {pg.checked}/{pg.total}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* ツールバー */}
          <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
            {mode === "lens" && selProgress && (
              <span className="text-slate-600">
                <span className="tabular-nums font-medium">
                  {selProgress.checked}/{selProgress.total}
                </span>
                {selProgress.continuousUntil && (
                  <span className="ml-2 text-emerald-600">
                    〜{selProgress.continuousUntil} 反映済み
                  </span>
                )}
              </span>
            )}
            {mode === "digest" && (
              <span className="text-slate-600 text-xs">
                このページ: 残り{" "}
                <span className="tabular-nums font-medium">{remainingCount}</span> /{" "}
                {items.length} 行
              </span>
            )}
            {source.mentionApplicable && (
              <label className="flex items-center gap-1.5 text-slate-600 text-xs">
                <input
                  type="checkbox"
                  checked={mentionOn}
                  onChange={(e) => nav({ mentions: e.target.checked, page: 1 })}
                />
                坂井新奈に言及あり
              </label>
            )}
            <label className="flex items-center gap-1.5 text-slate-600 text-xs">
              <input
                type="checkbox"
                checked={showCompleted}
                onChange={(e) => setShowCompleted(e.target.checked)}
              />
              完了済みを表示
            </label>
            <button
              onClick={() => nav({ order: order === "asc" ? "desc" : "asc", page: 1 })}
              className="px-2 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100 text-xs"
            >
              並び: {order === "asc" ? "古い順 ↑" : "新しい順 ↓"}
            </button>
            {canEdit && source.mentionApplicable && (
              <button
                onClick={bulkAllMentionless}
                className="px-2 py-1 rounded-md border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 text-xs"
              >
                言及なしを全部✓（全期間・全観点）
              </button>
            )}
          </div>

          {msg && <p className="text-xs text-slate-500 mb-2">{msg}</p>}

          {/* アイテム一覧 */}
          <ul className="border border-slate-200 rounded-lg divide-y divide-slate-100 overflow-hidden">
            {visibleItems.map((item) => {
              const done = isDone(item);
              const isOpen = expanded.has(item.itemKey);
              const dossiers = item.dossiers ?? [];
              const excerpts = item.excerpts ?? [];
              const images = item.imageAssets ?? [];
              const extraImages = (item.imageAssetCount ?? images.length) - images.length;
              const titleHref = item.repAsset ? `/assets/${item.repAsset.id}` : null;
              const titleText = item.itemTitle || item.itemKey;
              return (
                <li key={item.itemKey} className={done ? "opacity-60 bg-slate-50/60" : ""}>
                  <div className="flex items-start gap-2 px-3 py-2">
                    {mode === "lens" && sel && (
                      <input
                        type="checkbox"
                        checked={isChecked(item, sel)}
                        disabled={!canEdit}
                        onChange={(e) => toggle(item, sel, e.target.checked)}
                        className="shrink-0 mt-1"
                        title={`${sel} でチェック`}
                      />
                    )}
                    <div className="w-[5.2rem] shrink-0 text-xs text-slate-500 tabular-nums whitespace-nowrap mt-0.5">
                      {item.itemDate ?? "―"}
                    </div>
                    <div className="min-w-0 flex-1">
                      {/* タイトル: Akashic の代表アセットへ。原典 URL は外部リンクアイコン */}
                      <div className="flex items-center gap-1.5">
                        {titleHref ? (
                          <Link
                            href={titleHref}
                            className="text-sm text-slate-800 hover:text-slate-950 hover:underline truncate"
                          >
                            {titleText}
                          </Link>
                        ) : item.isUrl ? (
                          <a
                            href={item.itemKey}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm text-slate-800 hover:text-slate-950 hover:underline truncate"
                          >
                            {titleText}
                          </a>
                        ) : (
                          <span className="text-sm text-slate-800 truncate">{titleText}</span>
                        )}
                        {item.isUrl && titleHref && (
                          <a
                            href={item.itemKey}
                            target="_blank"
                            rel="noreferrer"
                            className="shrink-0 text-slate-400 hover:text-slate-700"
                            title="公式ページを開く"
                          >
                            <ExternalLink size={13} />
                          </a>
                        )}
                        {source.mentionApplicable && item.mentions && (
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700 font-medium">
                            言及
                          </span>
                        )}
                      </div>

                      {/* 抜粋スニペット（url=一致箇所ハイライト / talk=先頭プレビュー） */}
                      {excerpts.length > 0 && (
                        <div className="mt-1 space-y-0.5">
                          {excerpts.map((ex, i) => (
                            <p
                              key={i}
                              className="text-[11px] leading-snug text-slate-500 [&_mark]:bg-amber-200 [&_mark]:text-slate-900 [&_mark]:rounded [&_mark]:px-0.5"
                              dangerouslySetInnerHTML={{ __html: ex }}
                            />
                          ))}
                        </div>
                      )}

                      {/* ドシエバッジ・テキストアセットリンク */}
                      {(dossiers.length > 0 || item.repAsset?.kind === "text") && (
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                          {dossiers.map((d) => (
                            <Link
                              key={d.id}
                              href={`/dossiers/${d.id}`}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 hover:bg-indigo-100 truncate max-w-[16rem]"
                              title={`ドシエ: ${d.title}`}
                            >
                              📋 {d.title}
                            </Link>
                          ))}
                          {item.repAsset?.kind === "text" && (
                            <Link
                              href={`/assets/${item.repAsset.id}`}
                              className="inline-flex items-center gap-0.5 text-[10px] text-slate-400 hover:text-slate-700"
                              title="テキストアセットを開く"
                            >
                              <FileText size={11} />
                              テキスト
                            </Link>
                          )}
                        </div>
                      )}

                      {/* 画像アセットのサムネイルストリップ → ライトボックス */}
                      {images.length > 0 && (
                        <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                          {images.map((img, i) => (
                            <button
                              key={img.id}
                              type="button"
                              onClick={() => setLightbox({ images, index: i, title: titleText })}
                              className="h-12 w-12 rounded overflow-hidden bg-slate-100 hover:opacity-80 transition-opacity shrink-0"
                              title="拡大表示"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={thumbUrl(img.id)}
                                alt=""
                                loading="lazy"
                                className="h-full w-full object-cover"
                              />
                            </button>
                          ))}
                          {extraImages > 0 && (
                            <span className="text-[10px] text-slate-400">+{extraImages}</span>
                          )}
                        </div>
                      )}

                      {/* 消化モード: 全観点チップ常時表示＋「残りの観点は該当なし」 */}
                      {mode === "digest" && (
                        <div className="mt-2 flex flex-wrap items-center gap-1">
                          {lenses.map((l) => {
                            const on = isChecked(item, l.key);
                            return (
                              <button
                                key={l.key}
                                type="button"
                                disabled={!canEdit}
                                onClick={() => toggle(item, l.key, !on)}
                                className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors disabled:cursor-default ${
                                  on
                                    ? "bg-emerald-600 border-emerald-600 text-white"
                                    : "bg-white border-slate-200 text-slate-500 hover:border-slate-400 hover:text-slate-700"
                                }`}
                                title={on ? `${l.name} のチェックを外す` : `${l.name} にチェック`}
                              >
                                {on ? "✓ " : ""}
                                {l.name}
                              </button>
                            );
                          })}
                          {canEdit && !isComplete(item) && (
                            <button
                              type="button"
                              onClick={() => checkRemaining(item)}
                              className="text-[11px] px-2 py-0.5 rounded-full border border-slate-300 bg-slate-100 text-slate-600 hover:bg-slate-200 ml-1"
                              title="未チェックの観点をすべて✓して行を完了"
                            >
                              残りの観点は該当なし
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    {/* 範囲一括メニュー */}
                    {canEdit && item.itemDate && (
                      <button
                        onClick={() =>
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            if (next.has(item.itemKey)) next.delete(item.itemKey);
                            else next.add(item.itemKey);
                            return next;
                          })
                        }
                        className="shrink-0 text-xs text-slate-400 hover:text-slate-700 px-1 mt-0.5"
                        title="範囲一括メニュー"
                      >
                        {isOpen ? "▾" : "▸"}
                      </button>
                    )}
                  </div>

                  {isOpen && canEdit && item.itemDate && (
                    <div className="px-3 pb-3 pt-2 bg-slate-50/60 border-t border-slate-100">
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => bulk(item, "one")}
                          disabled={mode === "digest" || !sel}
                          className="text-xs px-2 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                          title={mode === "digest" ? "観点モードで使用できます" : undefined}
                        >
                          ここまで全部✓（この観点）
                        </button>
                        <button
                          onClick={() => bulk(item, "all")}
                          className="text-xs px-2 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100"
                        >
                          ここまで全部✓（全観点）
                        </button>
                        {source.mentionApplicable && (
                          <>
                            <button
                              onClick={() => bulk(item, "one", true)}
                              disabled={mode === "digest" || !sel}
                              className="text-xs px-2 py-1 rounded-md border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                              title={mode === "digest" ? "観点モードで使用できます" : undefined}
                            >
                              言及なしをここまで✓（この観点）
                            </button>
                            <button
                              onClick={() => bulk(item, "all", true)}
                              className="text-xs px-2 py-1 rounded-md border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100"
                            >
                              言及なしをここまで✓（全観点）
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
            {visibleItems.length === 0 && (
              <li className="py-6 text-center text-slate-400 text-sm">
                {items.length > 0
                  ? "このページのアイテムはすべて完了しています（「完了済みを表示」で確認できます）"
                  : "表示するアイテムがありません"}
              </li>
            )}
          </ul>

          {/* ページング */}
          <div className="flex items-center justify-between mt-3 text-sm text-slate-500">
            <span>
              {total} 件中 {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} 件
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => nav({ page: page - 1 })}
                disabled={page <= 1}
                className="px-2 py-1 rounded-md border border-slate-200 hover:bg-slate-100 disabled:opacity-40"
              >
                前へ
              </button>
              <span className="tabular-nums text-xs">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => nav({ page: page + 1 })}
                disabled={page >= totalPages}
                className="px-2 py-1 rounded-md border border-slate-200 hover:bg-slate-100 disabled:opacity-40"
              >
                次へ
              </button>
            </div>
          </div>
        </>
      )}

      {/* Undo トースト */}
      {undo && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-slate-900 text-white text-sm rounded-lg shadow-lg px-4 py-2.5 max-w-[90vw]">
          <span className="truncate">「{undo.itemTitle}」を完了しました</span>
          <button
            onClick={performUndo}
            className="inline-flex items-center gap-1 shrink-0 text-amber-300 hover:text-amber-200 font-medium"
          >
            <Undo2 size={14} />
            元に戻す
          </button>
          <button
            onClick={() => setUndo(null)}
            className="shrink-0 text-white/50 hover:text-white"
            aria-label="閉じる"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* ライトボックス */}
      {lightbox && lightbox.images[lightbox.index] && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center select-none"
          onClick={() => setLightbox(null)}
        >
          <button
            type="button"
            onClick={() => setLightbox(null)}
            aria-label="閉じる"
            className="absolute top-4 right-4 text-white/70 hover:text-white z-10 p-2 -m-2"
          >
            <X size={28} />
          </button>

          {lightbox.index > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setLightbox({ ...lightbox, index: lightbox.index - 1 });
              }}
              aria-label="前へ"
              className="absolute left-4 text-white/50 hover:text-white z-10 p-2"
            >
              <ChevronLeft size={32} />
            </button>
          )}
          {lightbox.index < lightbox.images.length - 1 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setLightbox({ ...lightbox, index: lightbox.index + 1 });
              }}
              aria-label="次へ"
              className="absolute right-4 text-white/50 hover:text-white z-10 p-2"
            >
              <ChevronRight size={32} />
            </button>
          )}

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumbUrl(lightbox.images[lightbox.index].id)}
            alt={lightbox.title}
            className="max-h-[85vh] max-w-[90vw] object-contain pointer-events-none"
            draggable={false}
          />

          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-14">
            <p className="text-white text-sm font-medium truncate">{lightbox.title}</p>
            <p className="text-white/60 text-xs mt-0.5 tabular-nums">
              {lightbox.index + 1} / {lightbox.images.length}
            </p>
            <Link
              href={`/assets/${lightbox.images[lightbox.index].id}`}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1.5 bg-white/10 hover:bg-white/20 text-white text-sm font-medium rounded-full px-4 py-2 mt-3 transition-colors"
            >
              <ExternalLink size={16} />
              アセットページ
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
