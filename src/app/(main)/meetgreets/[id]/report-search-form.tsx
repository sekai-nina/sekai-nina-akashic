"use client";

import { useMemo, useState, useTransition } from "react";
import type { ReportSearchPanel } from "@/lib/domain/meetgreet-import";
import type { RepoPreset } from "@/lib/domain/repo-presets";
import { cn } from "@/lib/utils";
import {
  formatReportGroups,
  parseReportGroups,
  previewReportQuery,
} from "@/lib/meetgreet/report-query";
import {
  deleteReportPresetAction,
  saveReportPresetAction,
  updateReportSearchAction,
} from "../actions";

const fieldCls =
  "w-full px-2 py-1 rounded-md border border-slate-200 bg-white text-xs text-slate-900 outline-none focus:border-slate-400";
const buttonCls =
  "h-8 px-3 rounded-md border border-slate-200 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50";

type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

/**
 * この回の収集の検索条件と、プリセットの管理。
 * プリセットを選ぶと入力欄に写すだけで、「この回に保存」を押すまで収集は変わらない
 */
export function ReportSearchForm({
  id,
  collection,
  presets,
  canSavePreset,
}: {
  id: string;
  collection: NonNullable<ReportSearchPanel["collection"]>;
  presets: RepoPreset[];
  /** 機密の回の条件はプリセットに写さない */
  canSavePreset: boolean;
}) {
  const { groups, extra, query, excludeRetweets, langJa } = collection;
  const [pending, startTransition] = useTransition();
  const [tagsText, setTagsText] = useState(formatReportGroups(groups));
  const [extraText, setExtraText] = useState(extra);
  const [presetId, setPresetId] = useState("");
  const [presetName, setPresetName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const parsed = useMemo(() => parseReportGroups(tagsText), [tagsText]);
  const preview = parsed.ok
    ? previewReportQuery(parsed.groups, extraText, { excludeRetweets, langJa })
    : null;
  // `/repo` のグループ間 AND や移行した収集は入力欄で表せず、保存すると検索式が変わる
  const notEditable = previewReportQuery(groups, extra, { excludeRetweets, langJa }) !== query;

  function pickPreset(nextId: string) {
    setPresetId(nextId);
    setMsg(null);
    const preset = presets.find((p) => p.id === nextId);
    if (!preset) {
      setPresetName("");
      return;
    }
    setPresetName(preset.name);
    setTagsText(formatReportGroups(preset.groups));
    setExtraText(preset.extra);
  }

  function run(
    action: () => Promise<ActionResult>,
    done: string,
    after?: (res: { id?: string }) => void
  ) {
    setMsg("保存中…");
    startTransition(async () => {
      const res = await action().catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "通信に失敗しました",
      }));
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setMsg(done);
      after?.(res);
    });
  }

  function search() {
    return parsed.ok ? { groups: parsed.groups, extra: extraText } : null;
  }

  function saveToCollection() {
    const input = search();
    if (input) run(() => updateReportSearchAction(id, input), "保存しました。次の収集から使います");
  }

  function savePreset() {
    const input = search();
    if (!input) return;
    run(
      () => saveReportPresetAction(id, { name: presetName, search: input }),
      "プリセットを追加しました",
      (res) => setPresetId(res.id ?? "")
    );
  }

  function overwritePreset() {
    const input = search();
    const preset = presets.find((p) => p.id === presetId);
    if (!input || !preset) return;
    if (!confirm(`プリセット「${preset.name}」を今の内容で上書きしますか？ 全員に反映され、元に戻せません`)) return;
    run(
      () => saveReportPresetAction(id, { id: preset.id, name: presetName, search: input }),
      "プリセットを上書きしました"
    );
  }

  function deletePreset() {
    const preset = presets.find((p) => p.id === presetId);
    if (!preset || !confirm(`プリセット「${preset.name}」を削除しますか？`)) return;
    run(() => deleteReportPresetAction(id, preset.id), "プリセットを削除しました", () => {
      setPresetId("");
      setPresetName("");
    });
  }

  return (
    <details className="mb-3 rounded-md border border-slate-200 px-3 py-2">
      <summary className="text-xs font-medium text-slate-700 cursor-pointer">
        検索条件
        <span className="ml-2 font-normal text-slate-500 break-all">{query}</span>
      </summary>

      <div className="mt-3 space-y-3">
        <div>
          <label className="block text-[11px] text-slate-500 mb-0.5" htmlFor="report-preset">
            プリセット (選ぶと下の欄に入ります)
          </label>
          <select
            id="report-preset"
            className={cn(fieldCls, "h-8")}
            value={presetId}
            onChange={(e) => pickPreset(e.target.value)}
            disabled={pending}
          >
            <option value="">プリセットを選ぶ</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-[11px] text-slate-500 mb-0.5" htmlFor="report-tags">
            ハッシュタグ (1 行 = 1 条件。行の中は空白で AND、OR を挟むと OR。行どうしは OR)
          </label>
          <textarea
            id="report-tags"
            className={fieldCls}
            rows={Math.max(3, tagsText.split("\n").length)}
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder={"#坂井新奈 #ミーグリ\n#にぃぐり"}
            disabled={pending}
          />
        </div>

        <div>
          <label className="block text-[11px] text-slate-500 mb-0.5" htmlFor="report-extra">
            追加条件 (X の検索式をそのまま。例: 坂井新奈 ミーグリ -from:example)
          </label>
          <input
            id="report-extra"
            className={fieldCls}
            value={extraText}
            onChange={(e) => setExtraText(e.target.value)}
            disabled={pending}
          />
        </div>

        {notEditable && (
          <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
            今の検索式はこの欄では表せません。保存すると、下の式に置き換わります。
          </p>
        )}

        <p className="text-[11px] text-slate-500 break-all">
          {parsed.ok ? (preview ?? "条件を入れてください") : <span className="text-red-700">{parsed.error}</span>}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={saveToCollection}
            disabled={pending || !preview}
            className="h-8 px-3 rounded-md bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50"
          >
            この回に保存
          </button>
          {msg && (
            <span role="status" className="text-[11px] text-slate-500">
              {msg}
            </span>
          )}
        </div>

        {canSavePreset && (
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
            <input
              aria-label="プリセットの名前"
              className={cn(fieldCls, "w-48 h-8")}
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder="プリセットの名前"
              disabled={pending}
            />
            <button
              type="button"
              onClick={savePreset}
              disabled={pending || !preview || !presetName.trim()}
              className={buttonCls}
            >
              新しいプリセットにする
            </button>
            {presetId && (
              <>
                <button
                  type="button"
                  onClick={overwritePreset}
                  disabled={pending || !preview || !presetName.trim()}
                  className={buttonCls}
                >
                  上書き
                </button>
                <button
                  type="button"
                  onClick={deletePreset}
                  disabled={pending}
                  className={cn(buttonCls, "text-red-600 hover:bg-red-50")}
                >
                  削除
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
