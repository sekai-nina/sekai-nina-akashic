"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { FileText } from "lucide-react";
import type { ArticlePreview } from "@/lib/domain/meetgreet-article-save";
import { previewArticleAction, saveArticleAction } from "../actions";

/**
 * 記事の生成。まず差分を見せ、確認してから保存する。
 * 既存記事があれば追記（増えた分だけ）、無ければ新規作成。
 */
export function ArticleStep({
  meetGreetId,
  hasArticle,
  hasDossier,
}: {
  meetGreetId: string;
  hasArticle: boolean;
  hasDossier: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<ArticlePreview | null>(null);

  if (!hasDossier) {
    return <p className="text-xs text-slate-400">ドシエが見えないため記事を作れません。</p>;
  }

  function load() {
    setMsg("組み立てています…");
    startTransition(async () => {
      const res = await previewArticleAction(meetGreetId).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "通信に失敗しました",
      }));
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setPreview(res.preview);
      setMsg(
        res.preview.empty
          ? "増えているものはありません"
          : res.preview.mode === "create"
            ? "新しい記事の本文です。確認して保存してください"
            : `${res.preview.addedLines.length} 行増えます`
      );
    });
  }

  function save() {
    setMsg("保存中…");
    startTransition(async () => {
      const res = await saveArticleAction(meetGreetId).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "通信に失敗しました",
      }));
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setMsg(
        res.mode === "create"
          ? `記事を作りました（出典 ${res.sources} 件）。公開は記事の push から`
          : `${res.added} 行を追記しました（出典 +${res.sources}）`
      );
      setPreview(null);
      router.refresh();
    });
  }

  const added = new Set(preview?.addedLines ?? []);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={load}
          disabled={pending}
          className="inline-flex items-center gap-1 h-8 px-3 rounded-md border border-slate-200 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          <FileText size={12} /> {hasArticle ? "追記する差分を見る" : "記事を組み立てる"}
        </button>
        {preview && !preview.empty && (
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="h-8 px-3 rounded-md bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50"
          >
            {preview.mode === "create" ? "この内容で作る" : "この差分を追記する"}
          </button>
        )}
        {msg && <span className="text-xs text-slate-500">{msg}</span>}
      </div>

      {preview && preview.droppedByClearance > 0 && (
        <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          機密レベルが internal を超えるアセット {preview.droppedByClearance} 件は本文に載せていません
          （記事は公開リポジトリに push されるため）。必要なら記事の編集画面から手で足してください。
        </p>
      )}

      {preview && !preview.empty && (
        <div>
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="text-xs font-medium text-slate-600">
              {preview.mode === "create" ? `本文（${preview.title}）` : "追記後の本文（緑が追加分）"}
            </span>
            {preview.newSources.length > 0 && (
              <span className="text-[11px] text-slate-500">出典 +{preview.newSources.length} 件</span>
            )}
          </div>
          <pre className="max-h-96 overflow-auto rounded-md border border-slate-200 bg-white text-[11px] leading-relaxed">
            {preview.body.split("\n").map((line, i) => (
              <div
                key={i}
                className={
                  "px-3 whitespace-pre-wrap break-all " +
                  (added.has(i) ? "bg-emerald-50 text-emerald-900" : "text-slate-700")
                }
              >
                {added.has(i) ? "+ " : "  "}
                {line}
              </div>
            ))}
          </pre>
          {preview.newSources.length > 0 && (
            <ul className="mt-2 text-[11px] text-slate-500 space-y-0.5">
              {preview.newSources.map((s) => (
                <li key={`${s.sourceNo}-${s.assetId ?? s.url}`}>
                  + 出典 {s.sourceNo}: {s.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
