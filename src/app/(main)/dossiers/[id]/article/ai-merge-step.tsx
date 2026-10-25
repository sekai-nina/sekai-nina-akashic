"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import type { MergeProposal } from "@/lib/domain/article-generate";
import { proposeMergeAction, saveMergeAction } from "./actions";

/**
 * 新しい素材を AI に既存の本文へ組み込ませ、人が直して保存する (#275)。
 *
 * 左に AI の案 (緑が AI の足した行。「手で直す」で編集)、右に新しい素材の中身。
 * 保存すると、本文で `^[n]` を使った出典だけが入り、使わなかったものは「今後足さない」になる。
 */
export function AiMergeStep({ dossierId, articleId }: { dossierId: string; articleId: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [proposal, setProposal] = useState<MergeProposal | null>(null);
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState(false);
  const [savedShortId, setSavedShortId] = useState<string | null>(null);

  /** いまの本文で使われている新しい出典の番号 */
  const used = useMemo(() => new Set([...body.matchAll(/\^\[(\d+)\]/g)].map((m) => Number(m[1]))), [body]);
  const changed = new Set(proposal?.changedLines ?? []);
  const mechanical = new Set(proposal?.mechanicalLines ?? []);

  function propose() {
    setMsg("AI が組み込んでいます…（1〜2 分かかります）");
    setSavedShortId(null);
    startTransition(async () => {
      const res = await proposeMergeAction(dossierId, articleId).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "通信に失敗しました",
      }));
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setProposal(res.proposal);
      setBody(res.proposal.body);
      setEditing(false);
      setMsg(
        res.proposal.changedLines.length === 0
          ? "AI は本文に足すことが無いと判断しました。手で足すか、出典だけ足す場合は下の差分を使ってください"
          : `AI が ${res.proposal.changedLines.length} 行を足しました。素材と見比べて、必要なら手で直してから保存してください`
      );
    });
  }

  function save() {
    if (!proposal) return;
    setMsg("保存中…");
    startTransition(async () => {
      const res = await saveMergeAction(dossierId, articleId, proposal.digest, body).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "通信に失敗しました",
      }));
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      const dropped = res.excluded > 0 ? ` / 使わなかった ${res.excluded} 件は今後足しません` : "";
      const failed = res.failed.length > 0 ? ` / 反映できなかった出典: ${res.failed.join("、")}` : "";
      setMsg(`保存しました（出典 +${res.sources}）${dropped}${failed}`);
      setSavedShortId(res.shortId);
      setProposal(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={propose}
          disabled={pending}
          className="inline-flex items-center gap-1 h-8 px-3 rounded-md bg-indigo-600 text-white text-xs hover:bg-indigo-700 disabled:opacity-50"
        >
          <Sparkles size={12} /> {proposal ? "もう一度 AI に組み込ませる" : "AI に組み込ませる"}
        </button>
        {proposal && (
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="h-8 px-3 rounded-md bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50"
          >
            この本文で保存する
          </button>
        )}
        {msg && (
          <span role="status" className="text-xs text-slate-500">
            {msg}
            {savedShortId && (
              <>
                {" "}
                <Link href={`/articles/${savedShortId}/edit`} className="underline hover:text-slate-700">
                  記事を開いて編集
                </Link>
              </>
            )}
          </span>
        )}
      </div>
      {!proposal && (
        <p className="text-[11px] text-slate-500">
          既存の本文と新しい素材を AI が読み、新しい行の差し込みと既存の行への出典番号の追加だけを行います（既存の文は変えません）。
          押すたびに費用がかかります（1 回数十円）。
        </p>
      )}

      {proposal && (
        <>
          <p className="text-[11px] rounded-md px-3 py-2 border text-slate-600 bg-slate-50 border-slate-200">
            AI ({proposal.ai.model}) の案です
            {proposal.ai.costUsd != null ? `（約 $${proposal.ai.costUsd.toFixed(3)}）` : ""}。
            事実の取り違え・他メンバーの感想・推測が無いか、右の素材と見比べてください。
          </p>
          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-xs font-medium text-slate-600">
                  {editing ? "本文（自由に直せます）" : "AI の案（緑が AI の足した行・黄が機械で足した画像・トークの行）"}
                </span>
                <button
                  type="button"
                  onClick={() => setEditing((v) => !v)}
                  disabled={pending}
                  className="text-[11px] text-indigo-700 hover:underline disabled:opacity-50"
                >
                  {editing ? "色付きで見る" : "手で直す"}
                </button>
              </div>
              {editing ? (
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  disabled={pending}
                  aria-label="保存する本文"
                  className="w-full h-64 sm:h-96 rounded-md border border-slate-200 bg-white p-3 font-mono text-[11px] leading-relaxed"
                />
              ) : (
                <div
                  role="region"
                  aria-label="AI の案"
                  tabIndex={0}
                  className="max-h-64 sm:max-h-96 overflow-auto rounded-md border border-slate-200 bg-white font-mono text-[11px] leading-relaxed"
                >
                  {body.split("\n").map((line, i) => (
                    <div
                      key={i}
                      className={
                        "px-3 whitespace-pre-wrap break-all " +
                        // 手で直したあとは行の位置がずれるので色を付けない
                        (body === proposal.body && changed.has(i)
                          ? "bg-emerald-50 text-emerald-900"
                          : mechanical.has(line)
                            ? "bg-amber-50 text-amber-900"
                            : "text-slate-700")
                      }
                    >
                      {line || " "}
                    </div>
                  ))}
                </div>
              )}
              <ul className="mt-2 text-[11px] space-y-0.5">
                {proposal.newSources.map((s) => (
                  <li key={s.sourceNo} className={used.has(s.sourceNo) ? "text-emerald-700" : "text-slate-400"}>
                    {used.has(s.sourceNo) ? "+ 出典" : "× 使わない（今後足さない）"} ^[{s.sourceNo}] {s.label}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-slate-400">
                使わない出典があると、保存時に番号を詰めて振り直します（本文の ^[n] も合わせて書き換えます）。
                {mechanical.size > 0 && " 黄色の行を消しても、その素材は反映待ちに残ります（載せないなら下の差分で外してください）。"}
              </p>
            </div>
            <div>
              <div className="text-xs font-medium text-slate-600 mb-1.5">新しい素材</div>
              <div className="max-h-64 sm:max-h-[28rem] overflow-auto space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
                {proposal.newSources.map((s) => (
                  <pre key={s.sourceNo} className="whitespace-pre-wrap break-all text-[11px] leading-relaxed text-slate-700">
                    {s.material || `^[${s.sourceNo}] ${s.label}（中身を読めませんでした）`}
                  </pre>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
