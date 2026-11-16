import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { listSceneVideos } from "@/lib/domain/video-scenes";
import { SCENE_LABELS as L, mediaSize } from "@/lib/video-scenes/policy";

export default async function VideoScenesPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const session = await auth();
  if (!session?.user) notFound();
  const query = await searchParams;
  const page = Math.min(5000, Math.max(1, Math.floor(Number(query.page) || 1)));
  const videos = await listSceneVideos(session.user.clearance, page);
  return <div className="mx-auto max-w-5xl"><h1 className="text-2xl font-bold">{L.title}</h1><p className="mt-2 text-sm text-slate-500">元動画を見て気になる瞬間を残すか、あらかじめ拾った場面から選びます。選んだ画像・短い動画をスマホに保存し、投稿用に仕上げられます。</p>
    <ul className="mt-5 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">{videos.map((v) => <li key={v.id}><Link prefetch={false} href={`/video-scenes/${v.id}`} className="flex min-h-20 items-center justify-between gap-4 p-4 hover:bg-slate-50"><div className="min-w-0"><p className="line-clamp-2 text-sm font-medium">{v.title || "動画"}</p><p className="mt-1 text-xs text-slate-500">元動画 {mediaSize(v.fileSize)}</p></div><span className="shrink-0 text-xs text-sky-700">{v.videoSceneTasks[0] ? L[v.videoSceneTasks[0].status as keyof typeof L] ?? "場面を見る" : "開く →"}</span></Link></li>)}</ul>
    {!videos.length && <p className="py-10 text-center text-sm text-slate-500">この条件の動画はありません。動画のアセット詳細からも開けます。</p>}
    <nav className="mt-4 flex justify-between text-sm">{page > 1 ? <Link href={`/video-scenes?page=${page - 1}`}>← 前へ</Link> : <span />}{videos.length === 25 && <Link href={`/video-scenes?page=${page + 1}`}>次へ →</Link>}</nav>
  </div>;
}
