"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ItemDTO } from "@/lib/domain/coverage";
import type { ItemRule } from "@prisma/client";
import { toggleCheckAction, bulkCheckAction } from "../actions";

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

export function ItemListClient({
  source,
  lenses,
  lensProgress,
  selectedLensKey,
  items: initialItems,
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
  const [uncheckedOnly, setUncheckedOnly] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const sel = selectedLensKey;
  const selProgress = sel ? progress[sel] : undefined;
  const isTalk = source.itemRule === "talk_date";

  function nav(next: {
    lens?: string;
    order?: "asc" | "desc";
    page?: number;
    mentions?: boolean;
  }) {
    const p = new URLSearchParams();
    p.set("lens", next.lens ?? sel ?? "");
    p.set("order", next.order ?? order);
    // 言及フィルタは URL パラメータ（母集団を絞るためサーバー側で適用）
    const nextMentions = next.mentions ?? mentionOn;
    if (source.mentionApplicable) p.set("mentions", nextMentions ? "1" : "0");
    if (next.page && next.page > 1) p.set("page", String(next.page));
    router.push(`/coverage/${source.key}?${p.toString()}`);
  }

  function isChecked(item: ItemDTO, lensKey: string): boolean {
    return (item.checkedLensKeys ?? []).includes(lensKey);
  }

  function setLocalChecked(itemKey: string, lensKey: string, checked: boolean) {
    setItems((prev) =>
      prev.map((it) => {
        if (it.itemKey !== itemKey) return it;
        const set = new Set(it.checkedLensKeys ?? []);
        if (checked) set.add(lensKey);
        else set.delete(lensKey);
        return { ...it, checkedLensKeys: [...set] };
      })
    );
    setProgress((prev) => {
      const cur = prev[lensKey];
      if (!cur) return prev;
      const delta = checked ? 1 : -1;
      return {
        ...prev,
        [lensKey]: { ...cur, checked: Math.max(0, Math.min(cur.total, cur.checked + delta)) },
      };
    });
  }

  async function toggle(item: ItemDTO, lensKey: string, checked: boolean) {
    if (!canEdit) return;
    setMsg(null);
    setLocalChecked(item.itemKey, lensKey, checked); // 楽観
    const res = await toggleCheckAction({
      lensKey,
      dataSourceKey: source.key,
      itemKey: item.itemKey,
      checked,
    });
    if (!res.ok) {
      setLocalChecked(item.itemKey, lensKey, !checked); // 失敗したら戻す
      setMsg(`エラー: ${res.error}`);
    }
  }

  /** scope: この観点 / 全観点。onlyMentionless: 言及なしのみを対象に一括✓ */
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

  const visibleItems = useMemo(() => {
    if (!uncheckedOnly || !sel) return items;
    return items.filter((it) => !isChecked(it, sel));
  }, [items, uncheckedOnly, sel]);

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
          {/* 観点タブ */}
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

          {/* ツールバー */}
          <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
            {selProgress && (
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
            <button
              onClick={() => nav({ order: order === "asc" ? "desc" : "asc", page: 1 })}
              className="px-2 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100 text-xs"
            >
              並び: {order === "asc" ? "古い順 ↑" : "新しい順 ↓"}
            </button>
            <label className="flex items-center gap-1.5 text-slate-600 text-xs">
              <input
                type="checkbox"
                checked={uncheckedOnly}
                onChange={(e) => setUncheckedOnly(e.target.checked)}
              />
              未チェックのみ（このページ内）
            </label>
          </div>

          {msg && <p className="text-xs text-slate-500 mb-2">{msg}</p>}

          {/* アイテム一覧 */}
          <ul className="border border-slate-200 rounded-lg divide-y divide-slate-100 overflow-hidden">
            {visibleItems.map((item) => {
              const checkedSel = sel ? isChecked(item, sel) : false;
              const isOpen = expanded.has(item.itemKey);
              const dossiers = item.dossiers ?? [];
              const assets = item.assets ?? [];
              const excerpts = item.excerpts ?? [];
              const extraAssets = (item.assetCount ?? assets.length) - assets.length;
              return (
                <li key={item.itemKey} className={!checkedSel && sel ? "bg-amber-50/40" : ""}>
                  <div className="flex items-start gap-2 px-3 py-2">
                    {sel && (
                      <input
                        type="checkbox"
                        checked={checkedSel}
                        disabled={!canEdit}
                        onChange={(e) => toggle(item, sel, e.target.checked)}
                        className="shrink-0 mt-1"
                        title={`${sel} でチェック`}
                      />
                    )}
                    <div className="w-16 shrink-0 text-xs text-slate-500 tabular-nums mt-0.5">
                      {item.itemDate ?? "―"}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {item.isUrl ? (
                          <a
                            href={item.itemKey}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm text-slate-800 hover:text-slate-950 hover:underline truncate"
                          >
                            {item.itemTitle || item.itemKey}
                          </a>
                        ) : (
                          <span className="text-sm text-slate-800 truncate">
                            {item.itemTitle || item.itemKey}
                          </span>
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

                      {/* ドシエバッジ・アセット導線 */}
                      {(dossiers.length > 0 || assets.length > 0) && (
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
                          {assets.length > 0 && (
                            <span className="text-[10px] text-slate-400">
                              アセット:
                              {assets.map((a) => (
                                <Link
                                  key={a.id}
                                  href={`/assets/${a.id}`}
                                  className="ml-1 text-slate-500 hover:text-slate-800 hover:underline"
                                  title={a.kind}
                                >
                                  {a.kind}
                                </Link>
                              ))}
                              {extraAssets > 0 && (
                                <span className="ml-1 text-slate-400">+{extraAssets}</span>
                              )}
                            </span>
                          )}
                        </div>
                      )}
                    </div>

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
                      title="全観点を展開"
                    >
                      {isOpen ? "▾" : "▸"}
                    </button>
                  </div>

                  {isOpen && (
                    <div className="px-3 pb-3 pt-1 bg-slate-50/60 border-t border-slate-100">
                      <div className="text-[11px] text-slate-400 mb-1.5">全観点</div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                        {lenses.map((l) => (
                          <label
                            key={l.key}
                            className="flex items-center gap-1.5 text-xs text-slate-700"
                          >
                            <input
                              type="checkbox"
                              checked={isChecked(item, l.key)}
                              disabled={!canEdit}
                              onChange={(e) => toggle(item, l.key, e.target.checked)}
                            />
                            {l.name}
                          </label>
                        ))}
                      </div>
                      {canEdit && item.itemDate && (
                        <div className="flex flex-wrap gap-2 mt-3">
                          <button
                            onClick={() => bulk(item, "one")}
                            disabled={!sel}
                            className="text-xs px-2 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100 disabled:opacity-50"
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
                                disabled={!sel}
                                className="text-xs px-2 py-1 rounded-md border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 disabled:opacity-50"
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
                      )}
                    </div>
                  )}
                </li>
              );
            })}
            {visibleItems.length === 0 && (
              <li className="py-6 text-center text-slate-400 text-sm">
                表示するアイテムがありません
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
    </div>
  );
}
