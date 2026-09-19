import { ExternalLink } from "lucide-react";
import { formatDate } from "@/lib/utils";
import type { HitView } from "@/lib/domain/x-mentions";

/** 拾ったツイートの一覧 (新しい順)。本文は全文を出す (読むための一覧なので畳まない)。リンクで X に飛ぶ */
export function HitList({ items }: { items: HitView[] }) {
  if (items.length === 0) {
    return <p className="text-slate-400 py-6 text-center text-sm">まだ拾ったツイートはありません</p>;
  }
  return (
    <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
      {items.map((h) => (
        <div key={h.id} className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
            <span className="font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{h.watchQuery}</span>
            <span className="text-slate-700 font-medium">
              {h.authorName || `@${h.authorUsername}`}
              {h.authorName && <span className="text-slate-400 font-normal"> @{h.authorUsername}</span>}
            </span>
            <span>{h.tweetedAt ? formatDate(h.tweetedAt, true) : ""}</span>
            {!h.notifiedAt && <span className="text-amber-600">未通知</span>}
            <a
              href={h.url}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-slate-500 hover:text-slate-900"
            >
              X で開く <ExternalLink size={12} />
            </a>
          </div>
          <p className="text-sm text-slate-800 mt-1 whitespace-pre-wrap break-words">{h.text}</p>
        </div>
      ))}
    </div>
  );
}
