"use client";

import { useMemo, useRef, useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { CoverageMatrixDTO } from "@/lib/domain/coverage";
import type { CoverageStatus, DataSourceKind, ItemRule } from "@prisma/client";
import {
  upsertCellAction,
  createLensAction,
  updateLensAction,
  createDataSourceAction,
  updateDataSourceAction,
} from "./actions";

type Lens = CoverageMatrixDTO["lenses"][number];
type DataSource = CoverageMatrixDTO["dataSources"][number];
type Cell = CoverageMatrixDTO["cells"][number];

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

/** "YYYY-MM-DD" -> "M/D" */
function shortDate(dateStr: string): string {
  const [, m, d] = dateStr.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** continuousUntil(YYYY-MM-DD) から今日までの経過日数。 */
function daysAgo(dateStr: string): number {
  const d = new Date(dateStr + "T00:00:00.000Z").getTime();
  const today = new Date(todayStr() + "T00:00:00.000Z").getTime();
  return Math.round((today - d) / 86400000);
}

/** 経過日数に応じた淡い色（新しい→緑、古い→赤）。 */
function freshnessClass(days: number): string {
  if (days <= 14) return "text-emerald-600";
  if (days <= 45) return "text-amber-600";
  return "text-rose-600";
}

export function CoverageClient({
  matrix,
  canEdit,
}: {
  matrix: CoverageMatrixDTO;
  canEdit: boolean;
}) {
  const [tab, setTab] = useState<"matrix" | "settings">("matrix");

  return (
    <div>
      <div className="flex gap-1 mb-4 border-b border-slate-200">
        <TabButton active={tab === "matrix"} onClick={() => setTab("matrix")}>
          マトリクス
        </TabButton>
        <TabButton active={tab === "settings"} onClick={() => setTab("settings")}>
          観点・ソース管理
        </TabButton>
      </div>

      {tab === "matrix" ? (
        <Matrix matrix={matrix} canEdit={canEdit} />
      ) : (
        <Settings matrix={matrix} canEdit={canEdit} />
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
// Matrix
// ============================================================

function Matrix({ matrix, canEdit }: { matrix: CoverageMatrixDTO; canEdit: boolean }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // 有効なもののみ表示（無効化されたものは管理タブでのみ表示）
  const lenses = matrix.lenses.filter((l) => l.active);
  const dataSources = matrix.dataSources.filter((d) => d.active);

  const cellMap = useMemo(() => {
    const m = new Map<string, Cell>();
    for (const c of matrix.cells) m.set(`${c.lensId}:${c.dataSourceId}`, c);
    return m;
  }, [matrix.cells]);

  function refresh() {
    startTransition(() => router.refresh());
  }

  if (lenses.length === 0 || dataSources.length === 0) {
    return (
      <p className="text-slate-400 py-8 text-center text-sm">
        観点・データソースがまだありません。「観点・ソース管理」タブから追加するか、
        <code className="mx-1 px-1 bg-slate-100 rounded">pnpm cli:seed-coverage</code>
        で初期データを投入してください。
      </p>
    );
  }

  return (
    <div>
      {msg && <p className="text-xs text-slate-500 mb-2">{msg}</p>}
      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="min-w-full text-sm border-collapse">
          <thead>
            <tr className="bg-slate-50">
              <th className="sticky left-0 z-10 bg-slate-50 px-3 py-2 text-left font-medium text-slate-600 border-b border-r border-slate-200 min-w-[9rem]">
                観点 \ ソース
              </th>
              {dataSources.map((d) => (
                <th
                  key={d.id}
                  className="px-2 py-2 text-center font-medium text-slate-600 border-b border-slate-200 whitespace-nowrap min-w-[6.5rem]"
                  title={d.description ?? undefined}
                >
                  {d.name}
                  {!d.public && (
                    <span className="ml-1 text-[10px] text-slate-400">(非公開)</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lenses.map((lens) => (
              <tr key={lens.id} className="hover:bg-slate-50/50">
                <th className="sticky left-0 z-10 bg-white px-3 py-2 text-left font-medium text-slate-700 border-b border-r border-slate-200 align-top">
                  <span title={lens.description}>
                    {lens.name}
                    {!lens.public && (
                      <span className="ml-1 text-[10px] text-slate-400">(非公開)</span>
                    )}
                  </span>
                </th>
                {dataSources.map((d) => {
                  const key = `${lens.id}:${d.id}`;
                  const cell = cellMap.get(key) ?? null;
                  return (
                    <td
                      key={d.id}
                      className="relative border-b border-r border-slate-100 p-0 text-center align-middle"
                    >
                      <MatrixCell
                        cell={cell}
                        dataSource={d}
                        canEdit={canEdit}
                        open={openKey === key}
                        onEditToggle={() => setOpenKey(openKey === key ? null : key)}
                        onClose={() => setOpenKey(null)}
                        lensKey={lens.key}
                        onDone={(m) => {
                          setMsg(m ?? null);
                          setOpenKey(null);
                          refresh();
                        }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-400 mt-3">
        セル = <span className="tabular-nums">済/総</span> と「〜M/D済」（連続チェック済みの日付）。
        セルをクリックするとアイテム一覧が開きます。グレー「—」= 対象外(not_applicable)。
        {canEdit && " 右上の ⋯ で対象外/メモを編集。"}
      </p>
    </div>
  );
}

function MatrixCell({
  cell,
  dataSource,
  canEdit,
  open,
  onEditToggle,
  onClose,
  lensKey,
  onDone,
}: {
  cell: Cell | null;
  dataSource: DataSource;
  canEdit: boolean;
  open: boolean;
  onEditToggle: () => void;
  onClose: () => void;
  lensKey: string;
  onDone: (msg?: string) => void;
}) {
  const router = useRouter();

  function goToItems() {
    router.push(`/coverage/${dataSource.key}?lens=${lensKey}`);
  }

  let content: React.ReactNode;
  if (cell && cell.status === "not_applicable") {
    content = <span className="text-slate-300">—</span>;
  } else if (dataSource.totalItems === 0) {
    content =
      dataSource.itemRule === "manual" ? (
        <span className="text-slate-300 text-[11px]">アイテム未定義</span>
      ) : (
        <span className="text-slate-400 tabular-nums">0/0</span>
      );
  } else {
    const checked = cell?.checkedItems ?? 0;
    const total = dataSource.totalItems;
    const complete = checked >= total && total > 0;
    content = (
      <div className="leading-tight">
        <div className={`tabular-nums ${complete ? "text-emerald-600 font-medium" : "text-slate-800"}`}>
          {checked}/{total}
        </div>
        {cell?.continuousUntil ? (
          <div className={`text-[10px] ${freshnessClass(daysAgo(cell.continuousUntil))}`}>
            〜{shortDate(cell.continuousUntil)}済
          </div>
        ) : (
          <div className="text-[10px] text-slate-300">未</div>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        onClick={goToItems}
        className="w-full h-full px-2 py-2 text-xs min-h-[3rem] cursor-pointer hover:bg-slate-100"
        title={`${dataSource.name} のアイテム一覧を開く`}
      >
        {content}
      </button>
      {canEdit && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEditToggle();
          }}
          className="absolute top-0.5 right-0.5 text-[11px] leading-none text-slate-300 hover:text-slate-600 px-1"
          title="対象外/メモを編集"
        >
          ⋯
        </button>
      )}
      {open && canEdit && (
        <CellNotePopover
          cell={cell}
          lensKey={lensKey}
          dataSourceKey={dataSource.key}
          onClose={onClose}
          onDone={onDone}
        />
      )}
    </>
  );
}

function CellNotePopover({
  cell,
  lensKey,
  dataSourceKey,
  onClose,
  onDone,
}: {
  cell: Cell | null;
  lensKey: string;
  dataSourceKey: string;
  onClose: () => void;
  onDone: (msg?: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<CoverageStatus>(cell?.status ?? "tracked");
  const [note, setNote] = useState<string>(cell?.note ?? "");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [onClose]);

  function save() {
    setErr(null);
    startTransition(async () => {
      const res = await upsertCellAction({
        lensKey,
        dataSourceKey,
        status,
        note: note.trim() || null,
      });
      if (!res.ok) setErr(res.error);
      else onDone();
    });
  }

  return (
    <div
      ref={ref}
      className="absolute z-30 top-full right-0 mt-1 w-64 bg-white border border-slate-300 rounded-lg shadow-lg p-3 text-left"
      onClick={(e) => e.stopPropagation()}
    >
      <label className="block text-xs text-slate-500 mb-1">状態</label>
      <select
        value={status}
        onChange={(e) => setStatus(e.target.value as CoverageStatus)}
        className="w-full px-2 py-1.5 rounded-md border border-slate-200 text-sm mb-2"
      >
        <option value="tracked">追跡する（済/総を表示）</option>
        <option value="not_applicable">対象外（—）</option>
      </select>

      <label className="block text-xs text-slate-500 mb-1">メモ（内部・非公開）</label>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        className="w-full px-2 py-1.5 rounded-md border border-slate-200 text-sm mb-2"
      />

      {err && <p className="text-xs text-rose-600 mb-2">{err}</p>}

      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={isPending}
          className="flex-1 px-3 py-1.5 text-sm rounded-md border border-slate-300 hover:bg-slate-100 disabled:opacity-50"
        >
          保存
        </button>
        <button
          onClick={onClose}
          disabled={isPending}
          className="px-3 py-1.5 text-sm rounded-md text-slate-500 hover:bg-slate-100"
        >
          閉じる
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Settings (観点・ソース管理)
// ============================================================

function Settings({ matrix, canEdit }: { matrix: CoverageMatrixDTO; canEdit: boolean }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <LensSettings lenses={matrix.lenses} canEdit={canEdit} />
      <DataSourceSettings dataSources={matrix.dataSources} canEdit={canEdit} />
    </div>
  );
}

const inputCls =
  "w-full px-3 py-2 rounded-md border border-slate-200 bg-white text-sm text-slate-900 outline-none focus:border-slate-400";
const labelCls = "block text-xs text-slate-500 mt-2 mb-1";

function LensSettings({ lenses, canEdit }: { lenses: Lens[]; canEdit: boolean }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setKey("");
    setName("");
    setDescription("");
    setIsPublic(true);
    setErr(null);
    setAdding(false);
  }

  function create() {
    setErr(null);
    setBusy(true);
    startTransition(async () => {
      const res = await createLensAction({ key, name, description, public: isPublic });
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
        <h2 className="text-sm font-medium text-slate-700">観点（Lens）</h2>
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
          <input className={inputCls} value={key} onChange={(e) => setKey(e.target.value)} placeholder="例: food" />
          <label className={labelCls}>表示名</label>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="例: 食べたもの" />
          <label className={labelCls}>説明</label>
          <textarea className={inputCls} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          <label className="flex items-center gap-1.5 mt-2 text-sm text-slate-700">
            <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
            公開サイトの鮮度表示に出す
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
        {lenses.map((l) => (
          <LensRow key={l.id} lens={l} canEdit={canEdit} />
        ))}
        {lenses.length === 0 && (
          <li className="py-4 text-center text-slate-400 text-sm">まだありません</li>
        )}
      </ul>
    </section>
  );
}

function LensRow({ lens, canEdit }: { lens: Lens; canEdit: boolean }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(lens.name);
  const [description, setDescription] = useState(lens.description);
  const [isPublic, setIsPublic] = useState(lens.public);
  const [active, setActive] = useState(lens.active);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function save() {
    setErr(null);
    setBusy(true);
    startTransition(async () => {
      const res = await updateLensAction(lens.id, { name, description, public: isPublic, active });
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
        <div className="text-[11px] text-slate-400 font-mono mb-1">{lens.key}</div>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        <textarea className={inputCls + " mt-2"} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
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
          {lens.name}
          {!lens.active && <span className="ml-1.5 text-[10px] text-rose-500">無効</span>}
          {!lens.public && <span className="ml-1.5 text-[10px] text-slate-400">非公開</span>}
        </div>
        <div className="text-xs text-slate-400 font-mono">{lens.key}</div>
        {lens.description && <p className="text-xs text-slate-500 mt-0.5 truncate max-w-xs">{lens.description}</p>}
      </div>
      {canEdit && (
        <button onClick={() => setEditing(true)} className="text-xs px-2 py-1 rounded text-slate-500 hover:bg-slate-100 shrink-0">
          編集
        </button>
      )}
    </li>
  );
}

function DataSourceSettings({ dataSources, canEdit }: { dataSources: DataSource[]; canEdit: boolean }) {
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
            公開サイトの鮮度表示に出す
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

function DataSourceRow({ ds, canEdit }: { ds: DataSource; canEdit: boolean }) {
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
          {ITEM_RULE_LABELS[ds.itemRule]} · {ds.totalItems} 件
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
