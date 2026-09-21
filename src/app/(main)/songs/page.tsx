import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { listSongs, type ListSongsOptions } from "@/lib/domain/songs";
import { RELEASE_KIND_LABELS, SONG_PARTICIPATION_LABELS } from "@/lib/utils";
import { SongFilter } from "./song-filter";

interface Props {
  searchParams: Promise<{ q?: string; participation?: string; orphan?: string }>;
}

/**
 * 曲マスタ (#167)。公式ディスコグラフィ (`pnpm cli:import-songs`) と公演フォームの入力から
 * できた曲の一覧。初出の作品と披露回数 (見えるライブのぶん) を出す。
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

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">曲</h1>
        <p className="text-slate-500 text-sm mt-1">
          公式ディスコグラフィと公演の入力からできた曲マスタ — {songs.length} 曲 (うち披露あり {performed})。
          新しいシングルは <code className="text-xs bg-slate-100 px-1 rounded">pnpm cli:import-songs --apply</code> で足す
        </p>
      </div>

      <SongFilter q={sp.q ?? ""} participation={opts.participation ?? ""} orphan={!!opts.orphan} />

      {songs.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-lg p-10 text-center text-sm text-slate-500">
          該当する曲がありません
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
          {songs.map((s) => (
            <Link
              key={s.id}
              href={`/songs/${s.id}`}
              className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 transition-colors"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
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
                </div>
                <p className="text-xs text-slate-500 mt-0.5 truncate">
                  {s.firstRelease
                    ? `${RELEASE_KIND_LABELS[s.firstRelease.kind]}「${s.firstRelease.title}」 ${s.firstRelease.releaseDate}${s.releaseCount > 1 ? ` 他 ${s.releaseCount - 1} 作品` : ""}`
                    : "未収録 (ライブ限定アレンジか誤字)"}
                  {s.artist && s.artist !== "日向坂46" && ` · ${s.artist}`}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <span className="text-sm font-semibold text-slate-700 tabular-nums">{s.performanceCount}</span>
                <span className="text-xs text-slate-400 ml-1">回披露</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
