"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createCollectionAction, fetchCollectionAction } from "./actions";

interface GroupState {
  tags: string;
  op: "and" | "or";
}

function parseTags(s: string): string[] {
  return s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function normTags(tags: string[]): string[] {
  return tags.map((t) => "#" + t.replace(/^#+/, "")).filter((t) => t.length > 1);
}

function buildGroupStr(tags: string[], op: "and" | "or"): string {
  const t = normTags(tags);
  if (t.length === 0) return "";
  const s = t.join(op === "or" ? " OR " : " ");
  return t.length > 1 ? `(${s})` : s;
}

const inputCls =
  "w-full px-3 py-2 rounded-md border border-slate-200 bg-white text-sm text-slate-900 outline-none focus:border-slate-400";
const labelCls = "block text-xs text-slate-500 mt-3 mb-1";

export function NewCollectionForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [groups, setGroups] = useState<GroupState[]>([{ tags: "", op: "and" }]);
  const [groupOp, setGroupOp] = useState<"and" | "or">("or");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [extra, setExtra] = useState("");
  const [excludeRetweets, setExcludeRetweets] = useState(true);
  const [langJa, setLangJa] = useState(true);

  const preview = useMemo(() => {
    const strs = groups.map((g) => buildGroupStr(parseTags(g.tags), g.op)).filter(Boolean);
    const parts: string[] = [];
    if (strs.length) {
      const core = strs.join(groupOp === "or" ? " OR " : " ");
      parts.push(strs.length > 1 ? `(${core})` : core);
    }
    if (extra.trim()) parts.push(extra.trim());
    let q = parts.join(" ");
    if (langJa) q += " lang:ja";
    if (excludeRetweets) q += " -is:retweet";
    return q.trim() || "(条件を入力)";
  }, [groups, groupOp, extra, langJa, excludeRetweets]);

  function updateGroup(i: number, patch: Partial<GroupState>) {
    setGroups((gs) => gs.map((g, idx) => (idx === i ? { ...g, ...patch } : g)));
  }
  function addGroup() {
    setGroups((gs) => [...gs, { tags: "", op: "and" }]);
  }
  function removeGroup(i: number) {
    setGroups((gs) => (gs.length <= 1 ? gs : gs.filter((_, idx) => idx !== i)));
  }

  function handleCreate() {
    if (!name.trim()) {
      setMsg("名前を入力してください");
      return;
    }
    const parsedGroups = groups
      .map((g) => ({ tags: parseTags(g.tags), op: g.op }))
      .filter((g) => g.tags.length > 0);
    if (parsedGroups.length === 0 && !extra.trim()) {
      setMsg("ハッシュタグか追加クエリを入力してください");
      return;
    }
    setMsg("作成中…");
    startTransition(async () => {
      const created = await createCollectionAction({
        name: name.trim(),
        groups: parsedGroups,
        groupOp,
        startDate: startDate || null,
        endDate: endDate || null,
        excludeRetweets,
        langJa,
        extra: extra.trim(),
      });
      if (!created.ok) {
        setMsg(`エラー: ${created.error}`);
        return;
      }
      setMsg("収集中…");
      const fetched = await fetchCollectionAction(created.id);
      if (!fetched.ok) {
        setMsg(`収集を作成しましたが取得に失敗: ${fetched.error}`);
      } else {
        setMsg(`${fetched.added} 件取得しました（一覧に追加）`);
      }
      router.refresh();
    });
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5">
      <h2 className="text-sm font-medium text-slate-700 mb-1">新しい収集を作成</h2>

      <label className={labelCls}>名前（例: 7thシングル 6/1 坂井新奈）</label>
      <input
        className={inputCls}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="ミーグリ名 / 日付"
      />

      <label className={labelCls}>
        ハッシュタグ条件（グループ内=カンマ/スペース区切り。# は省略可）
      </label>
      <div className="space-y-2">
        {groups.map((g, i) => (
          <div key={i} className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <input
              className={inputCls + " flex-1"}
              value={g.tags}
              onChange={(e) => updateGroup(i, { tags: e.target.value })}
              placeholder="例: 坂井新奈 ひなたみ"
            />
            <div className="flex gap-2">
              <select
                className={inputCls + " flex-1 sm:w-40"}
                value={g.op}
                onChange={(e) => updateGroup(i, { op: e.target.value as "and" | "or" })}
              >
                <option value="and">グループ内 AND</option>
                <option value="or">グループ内 OR</option>
              </select>
              <button
                type="button"
                onClick={() => removeGroup(i)}
                className="px-3 py-2 text-xs text-red-600 border border-red-200 rounded-md hover:bg-red-50 shrink-0"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={addGroup}
        className="mt-2 text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100"
      >
        ＋ 条件グループを追加
      </button>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
        <div>
          <label className={labelCls}>グループ間の結合</label>
          <select
            className={inputCls}
            value={groupOp}
            onChange={(e) => setGroupOp(e.target.value as "and" | "or")}
          >
            <option value="or">OR（どれかのグループに一致）</option>
            <option value="and">AND（すべてのグループに一致）</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>開始日（JST）</label>
          <input
            type="date"
            className={inputCls}
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls}>終了日（JST）</label>
          <input
            type="date"
            className={inputCls}
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>
      </div>

      <label className={labelCls}>追加クエリ（任意・X検索構文そのまま）</label>
      <input
        className={inputCls}
        value={extra}
        onChange={(e) => setExtra(e.target.value)}
        placeholder={'例: ("お話し会" OR ミーグリ)'}
      />

      <div className="flex gap-5 mt-3 text-sm text-slate-700">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={excludeRetweets}
            onChange={(e) => setExcludeRetweets(e.target.checked)}
          />
          リツイートを除外
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={langJa} onChange={(e) => setLangJa(e.target.checked)} />
          日本語のみ
        </label>
      </div>

      <div className="text-xs text-slate-400 mt-3">
        生成クエリ:{" "}
        <code className="px-1.5 py-0.5 bg-slate-100 rounded text-slate-600 font-mono">
          {preview}
        </code>
      </div>
      <p className="text-xs text-slate-400 mt-1">
        公式 API（recent search）は直近7日のみ遡れます。開催日直後の実行が前提です。
      </p>

      <div className="flex items-center gap-3 mt-4">
        <button
          onClick={handleCreate}
          disabled={isPending}
          className="px-4 py-2 text-sm rounded-md bg-slate-900 text-white hover:bg-slate-900/90 disabled:opacity-50"
        >
          {isPending ? "処理中…" : "作成して収集"}
        </button>
        {msg && <span className="text-xs text-slate-500">{msg}</span>}
      </div>
    </div>
  );
}
