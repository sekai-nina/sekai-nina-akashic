"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Check, FileText, Image as ImageIcon, Video } from "lucide-react";
import type { CandidateGroup } from "@/lib/meetgreet/candidates";
import { formatDate, MEETGREET_CANDIDATE_GROUP_LABELS } from "@/lib/utils";
import { applyMaterialsAction } from "../actions";

/**
 * 素材候補のチェックリスト。初期チェックは suggested、既にドシエにあるものは固定表示。
 * トークのテキスト (初期チェック無し) は数が多いので畳んでおく。
 */
export function MaterialsStep({ meetGreetId, groups }: { meetGreetId: string; groups: CandidateGroup[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [showAllTalkText, setShowAllTalkText] = useState(false);

  const initial = useMemo(
    () => new Set(groups.flatMap((g) => g.assets.filter((a) => a.suggested).map((a) => a.id))),
    [groups]
  );
  const [selected, setSelected] = useState<Set<string>>(initial);

  const selectable = groups.flatMap((g) => g.assets.filter((a) => !a.inDossier));

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroup(g: CandidateGroup) {
    const ids = g.assets.filter((a) => !a.inDossier).map((a) => a.id);
    const allOn = ids.every((id) => selected.has(id));
    setSelected((s) => {
      const next = new Set(s);
      for (const id of ids) {
        if (allOn) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  function apply() {
    const ids = [...selected];
    if (ids.length === 0) {
      setMsg("チェックされた素材がありません");
      return;
    }
    setMsg("反映中…");
    startTransition(async () => {
      const res = await applyMaterialsAction(meetGreetId, ids);
      setMsg(
        res.ok
          ? `${res.added} 件をドシエに追加しました${res.skipped > 0 ? `（${res.skipped} 件は追加済み）` : ""}`
          : `エラー: ${res.error}`
      );
      if (res.ok) router.refresh();
    });
  }

  if (groups.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        候補がありません (当日〜10 日後に本人のブログ・トークが取り込まれていないか、まだ先の日付です)。
      </p>
    );
  }

  return (
    <div>
      <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
        {groups.map((g) => {
          const ids = g.assets.filter((a) => !a.inDossier).map((a) => a.id);
          const onCount = ids.filter((id) => selected.has(id)).length;
          const isTalk = g.kind === "talk";
          // トークのテキストは初期チェック無しのものを畳む
          const hiddenTalkText = isTalk && !showAllTalkText
            ? g.assets.filter((a) => a.kind === "text" && !a.suggested && !a.inDossier)
            : [];
          const hiddenIds = new Set(hiddenTalkText.map((a) => a.id));
          const visible = g.assets.filter((a) => !hiddenIds.has(a.id));

          return (
            <div key={g.key}>
              <div className="flex items-center gap-2 px-3 py-2 bg-slate-50">
                {ids.length > 0 && (
                  <input
                    type="checkbox"
                    checked={onCount === ids.length}
                    ref={(el) => {
                      if (el) el.indeterminate = onCount > 0 && onCount < ids.length;
                    }}
                    onChange={() => toggleGroup(g)}
                    aria-label="グループを全部チェック"
                  />
                )}
                <span className="text-[11px] rounded-full border border-slate-200 bg-white px-2 py-0.5 text-slate-600">
                  {MEETGREET_CANDIDATE_GROUP_LABELS[g.kind]}
                </span>
                <span className="text-sm font-medium text-slate-800 truncate">
                  {g.url ? (
                    <a href={g.url} target="_blank" rel="noreferrer" className="hover:underline">
                      {g.title}
                    </a>
                  ) : (
                    g.title
                  )}
                </span>
                {g.matched && (
                  <span className="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                    本文にミーグリの話
                  </span>
                )}
                <span className="ml-auto text-xs text-slate-400 tabular-nums">
                  {onCount}/{ids.length}
                </span>
              </div>
              <ul>
                {visible.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 px-3 py-1.5">
                    {a.inDossier ? (
                      <span className="inline-flex w-[13px] justify-center text-emerald-600" title="ドシエに入っています">
                        <Check size={13} />
                      </span>
                    ) : (
                      <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} />
                    )}
                    <Thumb kind={a.kind} url={a.thumbnailUrl} title={a.title} />
                    <span className={"text-sm truncate " + (a.inDossier ? "text-slate-400" : "text-slate-800")}>
                      {a.title}
                    </span>
                    <span className="ml-auto text-xs text-slate-400 shrink-0">
                      {a.canonicalDate ? formatDate(a.canonicalDate, true) : ""}
                    </span>
                  </li>
                ))}
                {hiddenTalkText.length > 0 && (
                  <li className="px-3 py-1.5">
                    <button
                      type="button"
                      onClick={() => setShowAllTalkText(true)}
                      className="text-xs text-slate-500 hover:text-slate-800 underline underline-offset-2"
                    >
                      ミーグリの話が無いトークのテキストも表示 ({hiddenTalkText.length} 件)
                    </button>
                  </li>
                )}
              </ul>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={apply}
          disabled={pending || selectable.length === 0}
          className="h-9 px-4 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800 disabled:opacity-50"
        >
          ドシエに反映 ({selected.size})
        </button>
        {msg && <span className="text-xs text-slate-500">{msg}</span>}
      </div>
    </div>
  );
}

function Thumb({ kind, url, title }: { kind: string; url: string | null; title: string }) {
  if (url && kind !== "text") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={title} className="w-10 h-10 object-cover rounded bg-slate-100 shrink-0" />;
  }
  const Icon = kind === "video" ? Video : kind === "image" ? ImageIcon : FileText;
  return (
    <span className="inline-flex w-10 h-10 items-center justify-center rounded bg-slate-100 text-slate-400 shrink-0">
      <Icon size={16} />
    </span>
  );
}
