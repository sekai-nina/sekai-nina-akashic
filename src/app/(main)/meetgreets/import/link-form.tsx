"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Link2 } from "lucide-react";
import type { ArticleLinkCandidate } from "@/lib/domain/meetgreet-import";
import { linkArticlesAction } from "../actions";

/**
 * 公開済みの記事を MeetGreet に紐づける (#109)。
 * `/meetgreets` を作る前に書いた記事は frontmatter に `dossier.id` を持っているので、
 * それで機械的に突き合わせられる。紐づけると、以降は差分を追記できるようになる。
 */
export function ArticleLinkForm({ candidates }: { candidates: ArticleLinkCandidate[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(candidates.map((c) => c.meetGreetId))
  );

  if (candidates.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        紐づけられる記事はありません。
      </p>
    );
  }

  function link() {
    if (picked.size === 0) {
      setMsg("チェックされた記事がありません");
      return;
    }
    setMsg("紐づけています…");
    startTransition(async () => {
      const res = await linkArticlesAction([...picked]).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "通信に失敗しました",
      }));
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setMsg(
        res.failed.length === 0
          ? `${res.linked} 件を紐づけました`
          : `${res.linked} 件を紐づけ、${res.failed.length} 件は失敗しました`
      );
      router.refresh();
    });
  }

  return (
    <div>
      <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
        {candidates.map((c) => (
          <label
            key={c.meetGreetId}
            className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-slate-50"
          >
            <input
              type="checkbox"
              checked={picked.has(c.meetGreetId)}
              onChange={() =>
                setPicked((s) => {
                  const next = new Set(s);
                  if (next.has(c.meetGreetId)) next.delete(c.meetGreetId);
                  else next.add(c.meetGreetId);
                  return next;
                })
              }
              aria-label={c.articleTitle}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-slate-900 truncate">{c.articleTitle}</span>
              <span className="block text-xs text-slate-500 truncate mt-0.5">
                {c.dossierTitle} · /articles/{c.articleShortId}
              </span>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={link}
          disabled={pending || picked.size === 0}
          className="inline-flex items-center gap-1 h-9 px-4 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800 disabled:opacity-50"
        >
          <Link2 size={14} /> 紐づける ({picked.size})
        </button>
        {msg && <span className="text-xs text-slate-500">{msg}</span>}
      </div>
    </div>
  );
}
