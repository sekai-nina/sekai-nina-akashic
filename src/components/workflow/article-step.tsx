"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { FileText } from "lucide-react";
import { MAX_ARTICLE_CLEARANCE } from "@/lib/meetgreet/config";
import type { ArticlePreview } from "@/lib/meetgreet/types";
import type { AiDraft } from "@/lib/article-workflow/templates/types";

type ActionError = { ok: false; error: string };

/** プレビュー / 保存 / 戻す の結果。ミーグリ / ドシエ (/ ライブ) の Server Action が同じ形で返す */
type PreviewArticleResult = { ok: true; preview: ArticlePreview } | ActionError;
type SaveArticleActionResult =
  | { ok: true; mode: "create" | "append"; shortId: string; added: number; sources: number }
  | ActionError;
type RestoreExclusionsResult = { ok: true; restored: number } | ActionError;

/**
 * 記事の生成。まず差分を見せ、確認してから保存する。
 * 既存記事があれば追記（増えた分だけ）、無ければ新規作成。
 *
 * ミーグリ (#109) の部品を器に依らない形にしたもの (#170)。Server Action は器ごとに違うので
 * `onPreview` / `onSave` / `onRestore` で受け取る (`MaterialsStep.onApply` と同じ作り)。
 */
export function ArticleStep({
  hasArticle,
  hasDossier,
  onPreview,
  onSave,
  onRestore,
}: {
  hasArticle: boolean;
  hasDossier: boolean;
  /** 差分を組み立てる。`extraExclude` はまだ保存していない「外すつもり」のキー */
  onPreview: (extraExclude: string[]) => Promise<PreviewArticleResult>;
  /**
   * 保存する。`expectedDigest` は見せた本文の指紋、`exclude` は今回外すもの、
   * `aiDraft` はプレビューが返した AI の下書き (#171。器のテンプレートは受け取らない)
   */
  onSave: (
    expectedDigest: string | undefined,
    exclude: string[],
    aiDraft: AiDraft | null
  ) => Promise<SaveArticleActionResult>;
  /** 「今後足さない」を取り消す */
  onRestore: (keys: string[]) => Promise<RestoreExclusionsResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<ArticlePreview | null>(null);
  /** 足すものにチェック。外したものは「今後足さない」として覚える (#134) */
  const [keep, setKeep] = useState<Set<string>>(new Set());
  /** いま見せている本文に反映済みの「外すつもり」。チェックとズレたら見直しを促す */
  const [previewed, setPreviewed] = useState<string[]>([]);

  if (!hasDossier) {
    return <p className="text-xs text-slate-400">ドシエが見えないため記事を作れません。</p>;
  }

  /** 差分を取り直す。`overlay` を渡すと、外すつもりのものを引いた本文で見せる */
  function load(overlay: string[] = [], note?: string) {
    setMsg("組み立てています…");
    startTransition(async () => {
      const res = await onPreview(overlay).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "通信に失敗しました",
      }));
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setPreview(res.preview);
      setPreviewed(overlay);
      // **チェックは引き継ぐ。** 取り消しのたびに全部チェックに戻ると、
      // 外すつもりで外したものが黙って復活する
      const dropped = new Set(overlay);
      setKeep((prev) => {
        const known = prev.size > 0 || dropped.size > 0;
        return new Set(
          res.preview.additions
            .map((a) => a.key)
            .filter((k) => (known ? prev.has(k) || !dropped.has(k) : true))
        );
      });
      setMsg(
        note ??
          (res.preview.empty
            ? "増えているものはありません"
            : res.preview.mode === "create"
              ? res.preview.ai?.status === "generated"
                ? "AI が本文を書きました。確認して保存してください (下書きとして保存されます)"
                : "新しい記事の本文です。確認して保存してください"
              : `${res.preview.addedLines.length} 行増えます`)
      );
    });
  }

  function save() {
    if (!preview) return;
    const exclude = preview.additions.filter((a) => !keep.has(a.key)).map((a) => a.key);
    setMsg("保存中…");
    const digest = preview.digest;
    startTransition(async () => {
      // 見せた内容と保存する内容が食い違っていたら中止させる
      const res = await onSave(digest, exclude, preview.aiDraft ?? null).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "通信に失敗しました",
      }));
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      const dropped = exclude.length > 0 ? ` / ${exclude.length} 件は今後足しません` : "";
      setMsg(
        res.mode === "create"
          ? `記事を作りました（出典 ${res.sources} 件）。${preview.ai ? "下書きなので、記事の編集画面で確認して下書きを外してください" : "公開は記事の push から"}`
          : res.added === 0
            ? `本文は変えていません${dropped}`
            : `${res.added} 行を追記しました（出典 +${res.sources}）${dropped}`
      );
      setPreview(null);
      setPreviewed([]);
      router.refresh();
    });
  }

  function restore(key: string) {
    setMsg("戻しています…");
    startTransition(async () => {
      const res = await onRestore([key]).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "通信に失敗しました",
      }));
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      if (res.restored === 0) {
        // 別のタブで先に戻された等。黙って取り直すと「押したのに何も起きない」に見える
        setMsg("すでに戻されていました");
        return;
      }
      // 戻したものが候補に出てくるので、差分を取り直す
      load(previewed, "戻しました");
    });
  }

  const added = new Set(preview?.addedLines ?? []);
  /** チェックを外しているのに、いま見せている本文にはまだ入っているもの */
  const unchecked = (preview?.additions ?? []).filter((a) => !keep.has(a.key)).map((a) => a.key);
  const stale =
    unchecked.length !== previewed.length || unchecked.some((k) => !previewed.includes(k));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => load()}
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
            {preview.mode === "create"
              ? preview.ai
                ? "この内容で下書きを作る"
                : "この内容で作る"
              : "この差分を追記する"}
          </button>
        )}
        {preview && stale && (
          <button
            type="button"
            onClick={() => load(unchecked)}
            disabled={pending}
            className="h-8 px-3 rounded-md border border-slate-200 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            外した分を反映して見直す
          </button>
        )}
        {msg && (
          <span role="status" className="text-xs text-slate-500">
            {msg}
          </span>
        )}
      </div>

      {preview?.ai && (
        <p
          className={
            "text-[11px] rounded-md px-3 py-2 border " +
            (preview.ai.status === "unavailable"
              ? "text-amber-800 bg-amber-50 border-amber-200"
              : "text-slate-600 bg-slate-50 border-slate-200")
          }
        >
          {preview.ai.status === "unavailable" ? (
            <>
              AI が使えなかったので本文は空です（{preview.ai.reason}）。骨組み（出典だけ）で下書き保存し、記事の編集画面で書けます。
            </>
          ) : (
            <>
              {preview.ai.status === "generated" ? `AI (${preview.ai.model}) が書いた本文です。` : "画面から受け取った下書きです。"}
              素材 {preview.ai.included} 件
              {preview.ai.truncated > 0 ? `（うち ${preview.ai.truncated} 件は長すぎて途中まで）` : ""}
              {preview.ai.usage
                ? ` · 入力 ${preview.ai.usage.inputTokens.toLocaleString()} / 出力 ${preview.ai.usage.outputTokens.toLocaleString()} トークン`
                : ""}
              {preview.ai.costUsd != null ? ` · 約 $${preview.ai.costUsd.toFixed(3)}` : ""}
              。事実の取り違え・他メンバーの感想・推測が無いか、保存前に読んでください。
            </>
          )}
        </p>
      )}

      {preview && preview.droppedByClearance > 0 && (
        <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          機密レベルが {MAX_ARTICLE_CLEARANCE} を超えるアセット {preview.droppedByClearance} 件は本文に載せていません
          （記事は公開リポジトリに push されるため）。必要なら記事の編集画面から手で足してください。
        </p>
      )}

      {preview && preview.additions.length > 0 && (
        <div>
          <div className="text-xs font-medium text-slate-600 mb-1.5">
            足すもの（外したものは今後この素材からは提示されません）
          </div>
          <ul className="rounded-md border border-slate-200 divide-y divide-slate-100">
            {preview.additions.map((a) => (
              <li key={a.key}>
                <label className="flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-slate-50">
                  <input
                    type="checkbox"
                    className="mt-0.5 shrink-0"
                    checked={keep.has(a.key)}
                    onChange={() =>
                      setKeep((s) => {
                        const next = new Set(s);
                        if (next.has(a.key)) next.delete(a.key);
                        else next.add(a.key);
                        return next;
                      })
                    }
                    disabled={pending}
                  />
                  <span className="text-xs text-slate-700 break-all">{a.label}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview && preview.excluded.length > 0 && (
        <div>
          <div className="text-xs font-medium text-slate-600 mb-1.5">
            今後足さないもの（{preview.excluded.length} 件）
          </div>
          <ul className="rounded-md border border-slate-200 divide-y divide-slate-100">
            {preview.excluded.map((e) => (
              <li key={e.key} className="flex items-start gap-2 px-3 py-2">
                <span className="text-xs text-slate-500 break-all flex-1 line-through">
                  {e.label}
                </span>
                <button
                  type="button"
                  onClick={() => restore(e.key)}
                  disabled={pending}
                  aria-label={`${e.label} を戻す`}
                  className="shrink-0 h-6 px-2 rounded border border-slate-200 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  戻す
                </button>
              </li>
            ))}
          </ul>
        </div>
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
          {stale && (
            <p className="mb-1.5 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
              外した {unchecked.length} 件は、この本文にはまだ含まれています（保存時に除かれます）。
              反映した形で見るには「外した分を反映して見直す」を押してください。
            </p>
          )}
          <div
            role="region"
            aria-label="生成した本文のプレビュー"
            tabIndex={0}
            className="max-h-64 sm:max-h-96 overflow-auto rounded-md border border-slate-200 bg-white font-mono text-[11px] leading-relaxed"
          >
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
          </div>
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
