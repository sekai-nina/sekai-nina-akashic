import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getVideoScenes } from "@/lib/domain/video-scenes";
import { VideoSceneBoard } from "../scene-board";

export default async function VideoScenesPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ t?: string }>;
}) {
  const session = await auth();
  if (!session?.user) notFound();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const data = await getVideoScenes(session.user.clearance, id);
  if (!data) notFound();
  const time = Number(query.t);
  return <div className="mx-auto max-w-6xl"><VideoSceneBoard initial={data} editable={["admin", "member"].includes(session.user.role)} initialTime={Number.isFinite(time) && time >= 0 && time <= 86_400 ? time : 0} /></div>;
}
