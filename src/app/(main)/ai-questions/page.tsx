import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { listAiQuestions, RETENTION_DAYS } from "@/lib/domain/ai-questions";

/**
 * 案内AI「ふぃたん」に来た質問の一覧。
 *
 * 狙いは「アーカイブの穴探し」。何が聞かれているかをまず人が眺められることが出発点で、
 * とくに出典0件（＝答えられなかった）の質問が、記事にすべき話題の第一候補になる。
 * 個人を特定できる情報は受け取っていないので、行から人を辿ることはできない。
 */
export const dynamic = "force-dynamic";

const PER_PAGE = 50;

function formatJst(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default async function AiQuestionsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; noHit?: string; page?: string }>;
}) {
  const session = await auth();
  if (!session?.user) notFound();

  const params = await searchParams;
  const onlyNoHit = params.noHit === "1";
  const q = params.q?.trim() || "";
  const page = Math.max(Number(params.page ?? 1) || 1, 1);

  const { items, total, noHit } = await listAiQuestions(session.user.clearance, {
    onlyNoHit,
    q: q || undefined,
    take: PER_PAGE,
    skip: (page - 1) * PER_PAGE,
  });

  const pages = Math.max(Math.ceil(total / PER_PAGE), 1);
  const keep = (next: Record<string, string | undefined>) => {
    const sp = new URLSearchParams();
    const merged = { q: q || undefined, noHit: onlyNoHit ? "1" : undefined, ...next };
    for (const [k, v] of Object.entries(merged)) if (v) sp.set(k, v);
    const s = sp.toString();
    return s ? `/ai-questions?${s}` : "/ai-questions";
  };

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">案内AIへの質問</h1>
        <p className="text-slate-500 text-sm mt-1">
          サイトの案内AI「ふぃたん」に来た質問と回答です。
          <strong className="text-slate-700">出典が付かなかった質問</strong>
          は、まだ記事になっていない話題の候補です。
          個人を特定できる情報は記録していません（保存は最大{RETENTION_DAYS}日）。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <form className="flex gap-2" action="/ai-questions">
          {onlyNoHit && <input type="hidden" name="noHit" value="1" />}
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="質問・回答を検索"
            className="border border-slate-300 rounded px-3 py-1.5 text-sm"
          />
          <button type="submit" className="border border-slate-300 rounded px-3 py-1.5 text-sm hover:bg-slate-50">
            検索
          </button>
        </form>

        <Link
          href={keep({ noHit: onlyNoHit ? undefined : "1", page: undefined })}
          className={`rounded px-3 py-1.5 text-sm border ${
            onlyNoHit ? "bg-slate-900 text-white border-slate-900" : "border-slate-300 hover:bg-slate-50"
          }`}
        >
          答えられなかった質問だけ（{noHit}）
        </Link>

        <span className="text-sm text-slate-500 ml-auto">{total} 件</span>
      </div>

      {items.length === 0 ? (
        <p className="text-slate-500 text-sm py-12 text-center">該当する質問がありません。</p>
      ) : (
        <ul className="divide-y divide-slate-200 border-y border-slate-200">
          {items.map((item) => {
            const citations = (item.citations as { title: string; url: string }[]) ?? [];
            return (
              <li key={item.id} className="py-4">
                <div className="flex items-baseline gap-3">
                  <p className="font-medium text-slate-900 flex-1">{item.question}</p>
                  <time className="text-xs text-slate-400 shrink-0">{formatJst(item.askedAt)}</time>
                </div>
                <p className="text-sm text-slate-600 mt-1 whitespace-pre-wrap">{item.answer}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  {citations.length === 0 ? (
                    <span className="rounded bg-amber-100 text-amber-800 px-2 py-0.5">出典なし</span>
                  ) : (
                    citations.map((c) => (
                      <a
                        key={c.url}
                        href={c.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-slate-500 underline hover:text-slate-800"
                      >
                        {c.title}
                      </a>
                    ))
                  )}
                  {item.cached && <span className="text-slate-400">キャッシュ</span>}
                  {item.origin && <span className="text-slate-400">{item.origin}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm">
          {page > 1 ? (
            <Link href={keep({ page: String(page - 1) })} className="text-slate-600 hover:text-slate-900">
              ← 前
            </Link>
          ) : (
            <span />
          )}
          <span className="text-slate-500">
            {page} / {pages}
          </span>
          {page < pages ? (
            <Link href={keep({ page: String(page + 1) })} className="text-slate-600 hover:text-slate-900">
              次 →
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </div>
  );
}
