import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getSong, listMergeTargets } from "@/lib/domain/songs";
import { formatJpDate, LIVE_SONG_ROLE_LABELS, RELEASE_KIND_LABELS, SONG_PARTICIPATION_LABELS } from "@/lib/utils";
import { SongEditForm } from "./song-edit-form";
import { MergeForm } from "./merge-form";

interface Props {
  params: Promise<{ id: string }>;
}

/** 曲 1 件: 収録作品・披露した公演・編集・統合 */
export default async function SongDetailPage({ params }: Props) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) notFound();

  const song = await getSong(session.user, id);
  if (!song) notFound();

  const canEdit = ["admin", "member"].includes(session.user.role);
  const isAdmin = session.user.role === "admin";
  // 統合先の候補 (自分以外)。件数は高々数百
  const others = isAdmin ? await listMergeTargets(song.id) : [];
  const editionTitle = (release: { editions: unknown }, code: string) => {
    const list = Array.isArray(release.editions) ? release.editions : [];
    const hit = list.find((e): e is { code: string; title: string } => !!e && typeof e === "object" && (e as { code?: unknown }).code === code);
    return hit?.title ?? code;
  };

  return (
    <div className="max-w-3xl mx-auto">
      <Link href="/songs" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600">
        <ArrowLeft size={14} /> 曲一覧へ
      </Link>
      <div className="mt-2 mb-6">
        <h1 className="text-2xl font-bold text-slate-900">{song.title}</h1>
        <p className="text-xs text-slate-500 mt-1">
          {song.artist || "アーティスト未設定"} · 参加: {SONG_PARTICIPATION_LABELS[song.participation]} · 名寄せキー{" "}
          <code className="bg-slate-100 px-1 rounded">{song.normalizedTitle}</code>
        </p>
        {song.note && <p className="text-sm text-slate-600 mt-2 whitespace-pre-wrap">{song.note}</p>}
      </div>

      <section className="bg-white border border-slate-200 rounded-lg p-5 mb-4">
        <h2 className="text-sm font-semibold text-slate-900 mb-3">収録作品</h2>
        {song.tracks.length === 0 ? (
          <p className="text-sm text-slate-500">
            どの作品にも入っていません (ライブ限定アレンジか、公演フォームの誤字)。誤字なら下の「統合」で正しい曲に寄せてください。
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {song.tracks.map((t) => (
              <li key={`${t.release.id}`} className="py-2 text-sm">
                <div className="flex items-baseline gap-2">
                  <span className="text-[11px] rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-600 shrink-0">
                    {RELEASE_KIND_LABELS[t.release.kind]}
                  </span>
                  <span className="font-medium text-slate-900">{t.release.title}</span>
                  <span className="text-xs text-slate-500">{formatJpDate(t.release.releaseDate)}</span>
                  <span className="text-xs text-slate-400 ml-auto tabular-nums">
                    {t.discNo > 1 ? `Disc ${t.discNo} ` : ""}M{t.trackNo}
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  {t.editions.map((c) => editionTitle(t.release, c).replace(t.release.title, "").trim() || "通常盤").join(" / ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-white border border-slate-200 rounded-lg p-5 mb-4">
        <h2 className="text-sm font-semibold text-slate-900 mb-3">
          披露したライブ <span className="text-xs font-normal text-slate-500">(見えるライブのぶん)</span>
        </h2>
        {song.lives.length === 0 ? (
          <p className="text-sm text-slate-500">まだ披露の記録がありません</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {song.lives.map((l) => (
              <li key={l.id} className="py-2 text-sm">
                <Link href={`/lives/${l.id}`} className="font-medium text-slate-900 hover:underline inline-flex items-center gap-1">
                  {l.name} <ExternalLink size={12} className="text-slate-400" />
                </Link>
                <p className="text-xs text-slate-500 mt-0.5">
                  {l.common && "全公演の共通披露曲"}
                  {l.common && l.performances.length > 0 && " · "}
                  {performanceLines(l.performances).join(" / ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canEdit && (
        <section className="bg-white border border-slate-200 rounded-lg p-5 mb-4">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">編集</h2>
          <SongEditForm id={song.id} title={song.title} participation={song.participation} note={song.note} />
        </section>
      )}

      {isAdmin && (
        <section className="bg-white border border-slate-200 rounded-lg p-5 mb-4">
          <h2 className="text-sm font-semibold text-slate-900 mb-1">統合</h2>
          <p className="text-xs text-slate-500 mb-3">
            この曲を別の曲に寄せて消します (披露履歴は寄せ先に付け替わる)。誤字で二重になった曲を片付けるときに。
            統合元にできるのは未収録の曲だけ (公式表記の曲は統合先にする)。取り消せません。
          </p>
          <MergeForm sourceId={song.id} sourceTitle={song.title} candidates={others} />
        </section>
      )}
    </div>
  );
}

/**
 * 公演ごとの 1 行。同じ公演に披露曲としてもセンター曲としても入っていれば 1 行にまとめる
 */
function performanceLines(
  performances: { id: string; date: string; venue: string; label: string; role: string }[]
): string[] {
  const byId = new Map<string, { date: string; venue: string; label: string; roles: Set<string> }>();
  for (const p of performances) {
    const g = byId.get(p.id) ?? { date: p.date, venue: p.venue, label: p.label, roles: new Set<string>() };
    g.roles.add(p.role);
    byId.set(p.id, g);
  }
  return [...byId.values()].map(
    (p) =>
      `${p.date}${p.label ? ` ${p.label}` : ""}${p.venue ? ` ${p.venue}` : ""}${p.roles.has("center") ? ` (${LIVE_SONG_ROLE_LABELS.center})` : ""}`
  );
}
