import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import type { TalkDayScope } from "@/lib/clip-progress/talk-day";
import { getTalkDay } from "@/lib/domain/talk-day";
import { TALK_DAY_LABELS as L, cn } from "@/lib/utils";
import { TalkDayBoard } from "./talk-day-board";

const WEEKDAYS = "日月火水木金土";

/** その日のトークをトーク画面の形で見ながらクリップする。素材の進捗はトークだけ日単位。 */
export default async function TalkDayPage({ params, searchParams }: {
  params: Promise<{ sourceKey: string; day: string }>;
  searchParams: Promise<{ scope?: string }>;
}) {
  const { sourceKey, day } = await params;
  if (sourceKey !== "talk") notFound();
  const session = await auth();
  if (!session?.user) notFound();
  const scope: TalkDayScope = (await searchParams).scope === "all" ? "all" : "focus";
  const talk = await getTalkDay(session.user, day, scope);
  if (!talk) notFound();

  const dayHref = (d: string) => `/progress/materials/talk/${d}${scope === "all" ? "?scope=all" : ""}`;
  const [, month, date] = day.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Link className="text-slate-500 hover:text-slate-800" href="/progress/materials/talk">{L.back}</Link>
        <nav className="flex items-center gap-3">
          {talk.olderDay ? <Link className="text-indigo-700 hover:underline" href={dayHref(talk.olderDay)}>{L.previousDay}</Link> : <span />}
          <h2 className="font-semibold">{month}月{date}日 ({weekday})</h2>
          {talk.newerDay ? <Link className="text-indigo-700 hover:underline" href={dayHref(talk.newerDay)}>{L.nextDay}</Link> : <span />}
        </nav>
      </div>
      <nav className="flex gap-4 text-sm" aria-label={L.scopeNav}>
        {(["focus", "all"] as const).map((s) => (
          <Link key={s} href={`/progress/materials/talk/${day}${s === "all" ? "?scope=all" : ""}`}
            className={cn(s === scope ? "font-semibold underline" : "text-slate-500 hover:text-slate-800")}>
            {s === "all" ? `${L.scopeAll} (${talk.totalCount})` : `${L.scopeFocus} (${talk.focusCount})`}
          </Link>
        ))}
      </nav>
      <TalkDayBoard key={`${day}-${scope}`} talk={talk} editable={["admin", "member"].includes(session.user.role)} />
    </div>
  );
}
