import Link from "next/link";
import { notFound } from "next/navigation";
import { Clapperboard, Film, Play, Scissors, Smartphone } from "lucide-react";
import { auth } from "@/lib/auth";
import { listSceneVideos } from "@/lib/domain/video-scenes";
import { formatDate } from "@/lib/utils";
import { SCENE_LABELS as L, mediaSize } from "@/lib/video-scenes/policy";

const STATUS_STYLE: Record<string, string> = {
  ready: "bg-emerald-500/90 text-white",
  processing: "bg-amber-400/95 text-amber-950",
  queued: "bg-sky-500/90 text-white",
  failed: "bg-rose-500/90 text-white",
};

const STEPS = [
  { icon: Film, title: "動画を開く", body: "元動画か、拾った場面から" },
  { icon: Scissors, title: "瞬間を選ぶ", body: "コマや 90 秒までの範囲" },
  { icon: Smartphone, title: "スマホに保存", body: "そのまま投稿用に仕上げる" },
];

export default async function VideoScenesPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const session = await auth();
  if (!session?.user) notFound();
  const query = await searchParams;
  const page = Math.min(5000, Math.max(1, Math.floor(Number(query.page) || 1)));
  const videos = await listSceneVideos(session.user.clearance, page);
  return <div className="mx-auto max-w-6xl">
    <header className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-sky-600 via-sky-500 to-cyan-400 p-6 text-white shadow-sm sm:p-8">
      <Clapperboard aria-hidden className="absolute -right-6 -top-6 h-40 w-40 rotate-12 text-white/10" />
      <p className="text-xs font-semibold tracking-widest text-white/80">VIDEO SCENES</p>
      <h1 className="mt-1 text-2xl font-bold sm:text-3xl">{L.title}</h1>
      <p className="mt-2 max-w-xl text-sm text-white/90">元動画を見て気になる瞬間を残すか、あらかじめ拾った場面から選びます。選んだ画像・短い動画をスマホに保存し、投稿用に仕上げられます。</p>
      <ol className="mt-5 grid gap-2 sm:grid-cols-3">{STEPS.map((s, i) => <li key={s.title} className="flex items-center gap-3 rounded-xl bg-white/15 px-3 py-2.5 backdrop-blur-sm">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-sky-700"><s.icon size={18} /></span>
        <div className="min-w-0"><p className="text-sm font-semibold">{i + 1}. {s.title}</p><p className="text-xs text-white/80">{s.body}</p></div>
      </li>)}</ol>
    </header>

    {videos.length > 0 && <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{videos.map((v) => {
      const status = v.videoSceneTasks[0]?.status;
      const thumb = v.thumbnailUrl?.includes("/thumbnails/") ? v.thumbnailUrl : null;
      return <li key={v.id}><Link prefetch={false} href={`/video-scenes/${v.id}`} className="group block h-full overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-sky-300 hover:shadow-md">
        <div className="relative aspect-video bg-gradient-to-br from-slate-800 to-slate-950">
          {thumb ? <img src={thumb} alt="" loading="lazy" className="h-full w-full object-cover transition duration-300 group-hover:scale-105" />
            : <Film aria-hidden className="absolute inset-0 m-auto h-10 w-10 text-white/30" />}
          <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition group-hover:bg-black/25">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/90 text-sky-700 opacity-0 shadow transition group-hover:opacity-100"><Play size={20} className="ml-0.5" /></span>
          </span>
          {status && <span className={`absolute left-2 top-2 rounded-full px-2.5 py-0.5 text-xs font-medium shadow ${STATUS_STYLE[status] ?? "bg-slate-700/90 text-white"}`}>{L[status as keyof typeof L] ?? status}</span>}
          <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] text-white">{mediaSize(v.fileSize)}</span>
        </div>
        <div className="p-3">
          <p className="line-clamp-2 text-sm font-medium text-slate-900 group-hover:text-sky-700">{v.title || "動画"}</p>
          <p className="mt-1 flex items-center justify-between text-xs text-slate-500"><span>{formatDate(v.canonicalDate)}</span><span className="text-sky-700">{status === "ready" ? "場面を見る →" : "開く →"}</span></p>
        </div>
      </Link></li>;
    })}</ul>}
    {!videos.length && <div className="mt-6 rounded-xl border border-dashed border-slate-300 py-14 text-center"><Film aria-hidden className="mx-auto h-10 w-10 text-slate-300" /><p className="mt-3 text-sm text-slate-500">この条件の動画はありません。動画のアセット詳細からも開けます。</p></div>}
    <nav className="mt-6 flex justify-between text-sm">{page > 1 ? <Link href={`/video-scenes?page=${page - 1}`} className="rounded-lg border border-slate-300 bg-white px-4 py-2 hover:bg-slate-50">← 前へ</Link> : <span />}{videos.length === 25 && <Link href={`/video-scenes?page=${page + 1}`} className="rounded-lg border border-slate-300 bg-white px-4 py-2 hover:bg-slate-50">次へ →</Link>}</nav>
  </div>;
}
