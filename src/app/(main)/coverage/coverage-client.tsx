"use client";

import { Suspense, use, useRef, useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import { COVERAGE_LABELS as L, formatDate, jstDayString } from "@/lib/utils";
import type { CollectionSourceDTO, SourceItemStats } from "@/lib/domain/coverage";
import type { DataSourceKind, ItemRule } from "@prisma/client";
import { setCollectedUntilAction, createDataSourceAction, updateDataSourceAction } from "./actions";

type Source = CollectionSourceDTO;

const DATA_SOURCE_KINDS: DataSourceKind[] = [
  "blog",
  "talk",
  "tv",
  "youtube",
  "sns",
  "radio",
  "magazine",
  "live_event",
  "other",
];

const KIND_LABELS: Record<DataSourceKind, string> = {
  blog: "ブログ",
  talk: "トーク",
  tv: "テレビ",
  youtube: "YouTube",
  sns: "SNS",
  radio: "ラジオ",
  magazine: "雑誌",
  live_event: "ライブ/イベント",
  other: "その他",
};

const ITEM_RULES: ItemRule[] = ["blog_url", "talk_date", "source_url", "manual"];

const ITEM_RULE_LABELS: Record<ItemRule, string> = {
  blog_url: "記事URL単位 (blog_url)",
  talk_date: "日単位 (talk_date)",
  source_url: "URL単位 (source_url)",
  manual: "導出なし (manual)",
};

function todayStr(): string {
  return jstDayString(new Date());
}

/** 収集済みの日付(YYYY-MM-DD) から今日までの経過日数。 */
function daysAgo(dateStr: string): number {
  const d = new Date(dateStr + "T00:00:00.000Z").getTime();
  const today = new Date(todayStr() + "T00:00:00.000Z").getTime();
  return Math.round((today - d) / 86400000);
}

/** 経過日数に応じた色（新しい→緑、古い→赤）。 */
function freshnessClass(days: number): string {
  if (days <= 3) return "text-emerald-600";
  if (days <= 14) return "text-amber-600";
  return "text-rose-600";
}

export function CoverageClient({
  sources,
  stats,
  canEdit,
}: {
  sources: Source[];
  stats: Promise<Record<string, SourceItemStats>>;
  canEdit: boolean;
}) {
  const [tab, setTab] = useState<"list" | "settings">("list");

  return (
    <div>
      <div className="flex gap-1 mb-4 border-b border-slate-200">
        <TabButton active={tab === "list"} onClick={() => setTab("list")}>
          {L.list}
        </TabButton>
        <TabButton active={tab === "settings"} onClick={() => setTab("settings")}>
          {L.settings}
        </TabButton>
      </div>

      {tab === "list" ? (
        <SourceList sources={sources} stats={stats} canEdit={canEdit} />
      ) : (
        <div className="max-w-2xl">
          <DataSourceSettings dataSources={sources} canEdit={canEdit} />
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${
        active
          ? "border-slate-900 text-slate-900"
          : "border-transparent text-slate-500 hover:text-slate-700"
      }`}
    >
      {children}
    </button>
  );
}

// ============================================================
// 収集済みの日付（1 ソース 1 行）
// ============================================================

function SourceList({ sources, stats, canEdit }: {
  sources: Source[]; stats: Promise<Record<string, SourceItemStats>>; canEdit: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [openKey, setOpenKey] = useState<string | null>(null);

  // 無効化されたものはソース管理タブでのみ表示
  const active = sources.filter((s) => s.active);

  if (active.length === 0) {
    return (
      <p className="text-slate-400 py-8 text-center text-sm">
        {L.empty}
        <code className="mx-1 px-1 bg-slate-100 rounded">pnpm cli:seed-coverage</code>
      </p>
    );
  }

  return (
    <div>
      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="min-w-full text-sm border-collapse">
          <thead>
            <tr className="bg-slate-50 text-slate-600">
              <th className="px-3 py-2 text-left font-medium border-b border-slate-200">{L.source}</th>
              <th className="px-3 py-2 text-left font-medium border-b border-slate-200">{L.list}</th>
              <th className="px-3 py-2 text-left font-medium border-b border-slate-200">{L.method}</th>
              <th className="px-3 py-2 text-left font-medium border-b border-slate-200">{L.latest}</th>
            </tr>
          </thead>
          <tbody>
            {active.map((s) => (
              <SourceRow
                key={s.id}
                source={s}
                stats={stats}
                canEdit={canEdit}
                open={openKey === s.key}
                onOpen={() => setOpenKey(s.key)}
                onClose={() => setOpenKey(null)}
                onDone={() => {
                  setOpenKey(null);
                  startTransition(() => router.refresh());
                }}
              />
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-400 mt-3">{L.legend}</p>
    </div>
  );
}

function SourceRow({ source, stats, canEdit, open, onOpen, onClose, onDone }: {
  source: Source; stats: Promise<Record<string, SourceItemStats>>; canEdit: boolean; open: boolean;
  onOpen: () => void; onClose: () => void; onDone: () => void;
}) {
  const date = source.collectedUntil ? (
    <span className={`tabular-nums ${freshnessClass(daysAgo(source.collectedUntil))}`}>
      {source.collectedUntil.replaceAll("-", "/")} <span className="text-xs">{L.until}</span>
    </span>
  ) : <span className="text-slate-400">{L.unknown}</span>;

  return (
    <tr className="hover:bg-slate-50/50 align-top">
      <td className="px-3 py-2 border-b border-slate-100 whitespace-nowrap">
        <span className="font-medium text-slate-800" title={source.description ?? undefined}>{source.name}</span>
        {!source.public && <span className="ml-1.5 text-[10px] text-slate-400">{L.private}</span>}
      </td>
      <td className="px-3 py-2 border-b border-slate-100 whitespace-nowrap">
        {source.auto || !canEdit ? date : (
          <button type="button" onClick={onOpen} title={`${source.name}: ${L.edit}`}
            aria-label={`${source.name}: ${L.edit}（${source.collectedUntil ?? L.unknown}）`}
            className="-mx-1 px-1 rounded hover:bg-slate-100 underline decoration-dotted underline-offset-4 decoration-slate-300">
            {date}
          </button>
        )}
        {open && canEdit && !source.auto && <CollectedUntilDialog source={source} onClose={onClose} onDone={onDone} />}
      </td>
      <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-500">
        {source.auto ? (
          <>
            <span className="inline-block px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 mr-1.5">{L.auto}</span>
            {source.auto.jobName ?? source.auto.jobKey}
            <div className="mt-0.5">
              {source.auto.lastOkAt ? formatDate(source.auto.lastOkAt, true) : L.noReport}
              {source.auto.lastStatus === "error" && <span className="ml-1.5 text-rose-600">{L.lastError}</span>}
            </div>
          </>
        ) : (
          <>
            <span className="inline-block px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 mr-1.5">{L.manual}</span>
            {source.manual?.updatedAt && (
              <div className="mt-0.5">
                {L.lastSet}: {formatDate(source.manual.updatedAt, true)}
                {source.manual.updatedByName && ` / ${source.manual.updatedByName}`}
              </div>
            )}
          </>
        )}
      </td>
      <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-500 whitespace-nowrap tabular-nums">
        <Suspense fallback={<span className="text-slate-300">…</span>}>
          <ItemStats stats={stats} sourceKey={source.key} />
        </Suspense>
      </td>
    </tr>
  );
}

function ItemStats({ stats, sourceKey }: { stats: Promise<Record<string, SourceItemStats>>; sourceKey: string }) {
  const s = use(stats)[sourceKey];
  if (!s) return "—";
  return (
    <>
      {s.latestDate?.replaceAll("-", "/") ?? "—"}
      <span className="ml-1.5 text-slate-400">{s.count.toLocaleString()}{L.items}</span>
    </>
  );
}

function CollectedUntilDialog({ source, onClose, onDone }: {
  source: Source; onClose: () => void; onDone: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [isPending, startTransition] = useTransition();
  const [date, setDate] = useState(source.collectedUntil ?? "");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    startTransition(async () => {
      try {
        const res = await setCollectedUntilAction(source.key, date || null);
        if (!res.ok) setErr(res.error);
        else onDone();
      } catch { setErr(L.failed); }
    });
  }
  return (
    <dialog ref={ref} aria-labelledby="collected-until-title"
      onCancel={(e) => { e.preventDefault(); if (!isPending) onClose(); }}
      className="m-auto w-[min(24rem,calc(100vw-2rem))] max-h-[90dvh] overflow-y-auto rounded-lg border border-slate-300 bg-white p-5 shadow-xl backdrop:bg-black/40 text-left whitespace-normal">
      <h2 id="collected-until-title" className="font-semibold text-sm mb-4">{source.name}</h2>
      <form onSubmit={save}>
        <label htmlFor="collected-until" className="block text-xs text-slate-500 mb-1">{L.date}</label>
        <input id="collected-until" type="date" autoFocus min="1900-01-01" max={todayStr()} value={date} disabled={isPending}
          onChange={(e) => setDate(e.target.value)} aria-describedby="collected-until-help"
          className="w-full px-2 py-1.5 rounded-md border border-slate-200 text-sm" />
        <p id="collected-until-help" className="text-xs text-slate-500 mt-1 mb-3">{L.dateHelp}</p>
        {err && <p role="alert" className="text-xs text-rose-600 mb-3">{err}</p>}
        <div className="flex gap-2">
          <button type="submit" disabled={isPending} className="flex-1 px-3 py-1.5 text-sm rounded-md border border-slate-300 hover:bg-slate-100 disabled:opacity-50">{isPending ? L.saving : L.save}</button>
          <button type="button" disabled={isPending} onClick={onClose} className="px-3 py-1.5 text-sm rounded-md text-slate-500 hover:bg-slate-100">{L.close}</button>
        </div>
      </form>
    </dialog>
  );
}

// ============================================================
// ソース管理
// ============================================================

const inputCls =
  "w-full px-3 py-2 rounded-md border border-slate-200 bg-white text-sm text-slate-900 outline-none focus:border-slate-400";
const labelCls = "block text-xs text-slate-500 mt-2 mb-1";

function DataSourceSettings({ dataSources, canEdit }: { dataSources: Source[]; canEdit: boolean }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<DataSourceKind>("other");
  const [isPublic, setIsPublic] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setKey("");
    setName("");
    setKind("other");
    setIsPublic(true);
    setErr(null);
    setAdding(false);
  }

  function create() {
    setErr(null);
    setBusy(true);
    startTransition(async () => {
      const res = await createDataSourceAction({ key, name, kind, public: isPublic });
      setBusy(false);
      if (!res.ok) setErr(res.error);
      else {
        reset();
        router.refresh();
      }
    });
  }

  return (
    <section className="bg-white border border-slate-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-slate-700">データソース（DataSource）</h2>
        {canEdit && !adding && (
          <button
            onClick={() => setAdding(true)}
            className="text-xs px-2 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100"
          >
            ＋ 追加
          </button>
        )}
      </div>

      {adding && (
        <div className="mb-4 p-3 rounded-md bg-slate-50 border border-slate-200">
          <label className={labelCls}>key（作成後変更不可・英小文字/数字/_）</label>
          <input className={inputCls} value={key} onChange={(e) => setKey(e.target.value)} placeholder="例: blog" />
          <label className={labelCls}>表示名</label>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="例: 公式ブログ" />
          <label className={labelCls}>種別</label>
          <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as DataSourceKind)}>
            {DATA_SOURCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-slate-400 mt-1">
            アイテム導出規則（itemRule）は作成後に各行の「編集」から設定します（既定は manual）。
          </p>
          <label className="flex items-center gap-1.5 mt-2 text-sm text-slate-700">
            <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
            {L.showOnSite}
          </label>
          {err && <p className="text-xs text-rose-600 mt-2">{err}</p>}
          <div className="flex gap-2 mt-3">
            <button onClick={create} disabled={busy} className="px-3 py-1.5 text-sm rounded-md bg-slate-900 text-white hover:bg-slate-900/90 disabled:opacity-50">
              作成
            </button>
            <button onClick={reset} className="px-3 py-1.5 text-sm rounded-md text-slate-500 hover:bg-slate-100">
              キャンセル
            </button>
          </div>
        </div>
      )}

      <ul className="divide-y divide-slate-100">
        {dataSources.map((d) => (
          <DataSourceRow key={d.id} ds={d} canEdit={canEdit} />
        ))}
        {dataSources.length === 0 && (
          <li className="py-4 text-center text-slate-400 text-sm">まだありません</li>
        )}
      </ul>
    </section>
  );
}

function DataSourceRow({ ds, canEdit }: { ds: Source; canEdit: boolean }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(ds.name);
  const [kind, setKind] = useState<DataSourceKind>(ds.kind);
  const [itemRule, setItemRule] = useState<ItemRule>(ds.itemRule);
  const [publisherPattern, setPublisherPattern] = useState(ds.publisherPattern ?? "");
  const [titlePattern, setTitlePattern] = useState(ds.titlePattern ?? "");
  const [isPublic, setIsPublic] = useState(ds.public);
  const [active, setActive] = useState(ds.active);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function save() {
    setErr(null);
    setBusy(true);
    startTransition(async () => {
      const res = await updateDataSourceAction(ds.id, {
        name,
        kind,
        itemRule,
        publisherPattern: publisherPattern.trim() || null,
        titlePattern: titlePattern.trim() || null,
        public: isPublic,
        active,
      });
      setBusy(false);
      if (!res.ok) setErr(res.error);
      else {
        setEditing(false);
        router.refresh();
      }
    });
  }

  if (editing) {
    return (
      <li className="py-3">
        <div className="text-[11px] text-slate-400 font-mono mb-1">{ds.key}</div>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        <label className={labelCls}>種別</label>
        <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as DataSourceKind)}>
          {DATA_SOURCE_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <label className={labelCls}>アイテム導出規則（itemRule）</label>
        <select className={inputCls} value={itemRule} onChange={(e) => setItemRule(e.target.value as ItemRule)}>
          {ITEM_RULES.map((r) => (
            <option key={r} value={r}>
              {ITEM_RULE_LABELS[r]}
            </option>
          ))}
        </select>
        <label className={labelCls}>
          publisherPattern（SourceRecord.publisher への SQL LIKE・空=不問・
          <code>|</code> で複数パターン（OR））
        </label>
        <input
          className={inputCls}
          value={publisherPattern}
          onChange={(e) => setPublisherPattern(e.target.value)}
          placeholder="例: 日向坂46公式ブログ%（複数は EX大衆%|BRODY% のように | 区切り）"
        />
        <label className={labelCls}>
          titlePattern（SourceRecord.title への SQL LIKE・空=不問・
          <code>|</code> で複数パターン（OR））
        </label>
        <input
          className={inputCls}
          value={titlePattern}
          onChange={(e) => setTitlePattern(e.target.value)}
          placeholder="例: 日向坂ちゃんねる%（複数は #_ %|#__ % のように | 区切り）"
        />
        <div className="flex gap-4 mt-2">
          <label className="flex items-center gap-1.5 text-sm text-slate-700">
            <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
            公開表示
          </label>
          <label className="flex items-center gap-1.5 text-sm text-slate-700">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            有効
          </label>
        </div>
        {err && <p className="text-xs text-rose-600 mt-2">{err}</p>}
        <div className="flex gap-2 mt-2">
          <button onClick={save} disabled={busy} className="px-3 py-1 text-xs rounded-md bg-slate-900 text-white hover:bg-slate-900/90 disabled:opacity-50">
            保存
          </button>
          <button onClick={() => setEditing(false)} className="px-3 py-1 text-xs rounded-md text-slate-500 hover:bg-slate-100">
            キャンセル
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="py-2.5 flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="text-sm font-medium text-slate-800">
          {ds.name}
          <span className="ml-1.5 text-[10px] text-slate-400">{KIND_LABELS[ds.kind]}</span>
          {!ds.active && <span className="ml-1.5 text-[10px] text-rose-500">無効</span>}
          {!ds.public && <span className="ml-1.5 text-[10px] text-slate-400">非公開</span>}
        </div>
        <div className="text-xs text-slate-400 font-mono">{ds.key}</div>
        <div className="text-[11px] text-slate-500 mt-0.5">
          {ITEM_RULE_LABELS[ds.itemRule]}
          {ds.publisherPattern && (
            <span className="ml-1 text-slate-400">pub: {ds.publisherPattern}</span>
          )}
          {ds.titlePattern && (
            <span className="ml-1 text-slate-400">title: {ds.titlePattern}</span>
          )}
        </div>
      </div>
      {canEdit && (
        <button onClick={() => setEditing(true)} className="text-xs px-2 py-1 rounded text-slate-500 hover:bg-slate-100 shrink-0">
          編集
        </button>
      )}
    </li>
  );
}
