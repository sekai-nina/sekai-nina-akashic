import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { listSongs, type ListSongsOptions, type SongSummary } from "@/lib/domain/songs";
import { formatJpDate, RELEASE_KIND_LABELS, SONG_PARTICIPATION_LABELS } from "@/lib/utils";
import { SongFilter } from "./song-filter";

interface Props {
  searchParams: Promise<{ q?: string; participation?: string; orphan?: string }>;
}

/**
 * 曲マスタ (#167)。公式ディスコグラフィ (`pnpm cli:import-songs`) と公演フォームの入力から
 * できた曲を、**初出の作品ごと** (新しい順) にトラック順で並べる。アルバム再収録は初出の
 * シングルの側に出す (1 曲 1 回)。未収録の曲は末尾
 */
export default async function SongsPage({ searchParams }: Props) {
  const session = await auth();
  if (!session?.user) notFound();
  const sp = await searchParams;

  const opts: ListSongsOptions = {
    q: sp.q,
    participation:
      sp.participation === "member" || sp.participation === "none" || sp.participation === "unknown"
        ? sp.participation
        : undefined,
    orphan: sp.orphan === "1",
  };
  const songs = await listSongs(session.user, opts);
  const performed = songs.filter((s) => s.performanceCount > 0).length;

  // 初出の作品ごとにまとめる (listSongs が作品の新しい順 → トラック順に並べてある)
  const groups: { key: string; release: SongSummary["firstRelease"]; songs: SongSummary[] }[] = [];
  for (const s of songs) {
    const key = s.firstRelease?.id ?? "orphan";
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.songs.push(s);
    else groups.push({ key, release: s.firstRelease, songs: [s] });
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">曲</h1>
        <p className="text-slate-500 text-sm mt-1">
          公式ディスコグラフィと公演の入力からできた曲マスタ — {songs.length} 曲 (うち披露あり {performed})。
          初出の作品ごと (新しい順)。アルバム再収録は初出のシングルの側に出る。
          新しいシングルは <code className="text-xs bg-slate-100 px-1 rounded">pnpm cli:import-songs --apply</code> で足す
        </p>
      </div>

      <SongFilter q={sp.q ?? ""} participation={opts.participation ?? ""} orphan={!!opts.orphan} />

      {songs.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-lg p-10 text-center text-sm text-slate-500">
          該当する曲がありません
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.key}>
              <h2 className="text-sm font-semibold text-slate-800 mb-2 flex flex-wrap items-baseline gap-2">
                {g.release ? (
                  <>
                    <span className="inline-flex items-center rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
                      {RELEASE_KIND_LABELS[g.release.kind]}
                    </span>
                    <span>{g.release.title}</span>
                    <span className="text-xs font-normal text-slate-500">{formatJpDate(g.release.releaseDate)}</span>
                    {g.release.artist && g.release.artist !== "日向坂46" && (
                      <span className="text-xs font-normal text-slate-500">{g.release.artist}</span>
                    )}
                  </>
                ) : (
                  <>
                    <span className="inline-flex items-center rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
                      未収録
                    </span>
                    <span className="text-xs font-normal text-slate-500">ライブ限定アレンジ、けやき坂46 の曲、公演フォームの誤字など</span>
                  </>
                )}
                <span className="text-xs font-normal text-slate-400">{g.songs.length} 曲</span>
              </h2>
              <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
                {g.songs.map((s) => (
                  <Link
                    key={s.id}
                    href={`/songs/${s.id}`}
                    className="flex items-center gap-3 px-4 py-2 hover:bg-slate-50 transition-colors"
                  >
                    <span className="w-8 shrink-0 text-xs text-slate-400 tabular-nums text-right">
                      {s.firstTrack ? `${s.firstTrack.discNo > 1 ? `${s.firstTrack.discNo}-` : ""}${s.firstTrack.trackNo}` : ""}
                    </span>
                    <div className="min-w-0 flex-1 flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-900 truncate">{s.title}</span>
                      {s.participation !== "unknown" && (
                        <span
                          className={
                            "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] " +
                            (s.participation === "member"
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                              : "border-slate-200 bg-slate-50 text-slate-500")
                          }
                        >
                          {SONG_PARTICIPATION_LABELS[s.participation]}
                        </span>
                      )}
                      {s.releaseCount > 1 && (
                        <span className="shrink-0 text-[11px] text-slate-400">他 {s.releaseCount - 1} 作品にも収録</span>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      <span className={"text-sm font-semibold tabular-nums " + (s.performanceCount > 0 ? "text-slate-700" : "text-slate-300")}>
                        {s.performanceCount}
                      </span>
                      <span className="text-xs text-slate-400 ml-1">回披露</span>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
