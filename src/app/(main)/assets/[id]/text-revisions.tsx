"use client";

import { useMemo, useState } from "react";
import { diffChars } from "diff";
import { History } from "lucide-react";
import { IMG_PLACEHOLDER_RE, formatDate } from "@/lib/utils";

export interface TextRevision {
  id: string;
  version: number;
  content: string;
  /** ISO 8601 */
  fetchedAt: string;
}

interface TextRevisionsProps {
  /** 「本文」などの表示名 */
  label: string;
  /** 新しい順 */
  revisions: TextRevision[];
}

/** 画像プレースホルダは差分・全文とも「［画像］」で見せる (ID の差は読めないので) */
const display = (content: string) => content.replace(IMG_PLACEHOLDER_RE, "［画像］");

/**
 * 本文の版の履歴 (#262)。公式ブログが公開後に直されたとき、bot が版を積む。
 * 本文の選択 (クリップ・引用) の対象にしないよう、TextsSection の選択範囲の外に置く。
 */
export function TextRevisions({ label, revisions }: TextRevisionsProps) {
  // 閉じた <details> も中身は描画されるので、開くまで差分を計算しない (長い本文で重い)
  const [opened, setOpened] = useState(false);
  if (revisions.length < 2) return null;
  return (
    <details className="border border-slate-200 rounded-lg p-3" onToggle={(e) => e.currentTarget.open && setOpened(true)}>
      <summary className="text-sm text-slate-600 cursor-pointer hover:text-slate-800 flex items-center gap-1.5">
        <History className="w-3.5 h-3.5" />
        {label}の版の履歴 ({revisions.length})
      </summary>
      {opened && (
        <ol className="mt-3 space-y-3">
          {revisions.map((rev, i) => (
            <RevisionItem key={rev.id} revision={rev} previous={revisions[i + 1]} latest={i === 0} />
          ))}
        </ol>
      )}
    </details>
  );
}

function RevisionItem({
  revision,
  previous,
  latest,
}: {
  revision: TextRevision;
  previous?: TextRevision;
  latest: boolean;
}) {
  const [mode, setMode] = useState<"diff" | "full">(previous ? "diff" : "full");
  return (
    <li className="border border-slate-100 rounded p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-xs text-slate-600">
          <span className="font-medium">第 {revision.version} 版</span>
          <span className="ml-2 text-slate-400">{formatDate(revision.fetchedAt, true)} 取得</span>
          {latest && <span className="ml-2 text-teal-700">（現在の版）</span>}
          {!previous && <span className="ml-2 text-slate-400">（初版）</span>}
        </div>
        {previous && (
          <div className="flex text-[11px] border border-slate-200 rounded overflow-hidden">
            {(["diff", "full"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={`px-2 py-0.5 ${mode === m ? "bg-slate-700 text-white" : "text-slate-600 hover:bg-slate-50"}`}
              >
                {m === "diff" ? "差分" : "全文"}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">
        {mode === "diff" && previous ? <Diff before={previous.content} after={revision.content} /> : display(revision.content)}
      </div>
    </li>
  );
}

function Diff({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => diffChars(display(before), display(after)), [before, after]);
  return (
    <>
      {parts.map((part, i) =>
        part.added ? (
          <ins key={i} title="追加" className="bg-emerald-100 text-emerald-900 no-underline">
            <span className="sr-only">（追加: </span>
            {part.value}
            <span className="sr-only">）</span>
          </ins>
        ) : part.removed ? (
          <del key={i} title="削除" className="bg-rose-100 text-rose-900">
            <span className="sr-only">（削除: </span>
            {part.value}
            <span className="sr-only">）</span>
          </del>
        ) : (
          <span key={i}>{part.value}</span>
        )
      )}
    </>
  );
}
