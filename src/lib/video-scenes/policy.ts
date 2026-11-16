import { z } from "zod";

export const SCENE_VERSION = "scenes-v1";
export const SCENE_WORKER_PERMISSION = "video_scene_worker";
export const SHORT_VIDEO_SECONDS = 180;
export const MAX_EXPORT_SECONDS = 90;
export const MAX_MEDIA_BYTES = 100_000_000;
export const MEDIA_CHUNK_BYTES = 4_000_000;
export const SCENE_TASK_LEASE_MS = 10 * 60_000;
export { SCENE_LABELS } from "./labels";

const seconds = z.number().finite().min(0).max(86_400);
const id = z.string().min(1).max(100);
export const ExportRange = z.object({ start: seconds, end: seconds }).refine(
  (r) => r.end > r.start && r.end - r.start <= MAX_EXPORT_SECONDS,
  { message: `保存範囲は 0 秒より長く、${MAX_EXPORT_SECONDS} 秒以内にしてください` },
);
export const SceneManifest = z.object({
  duration: seconds.positive(),
  scenes: z.array(z.object({
    id,
    start: seconds,
    end: seconds,
    videoFileId: id.nullable(),
    posterFileId: id,
    shots: z.array(z.object({ fileId: id, time: seconds })).max(16),
  })).max(500),
}).superRefine((m, ctx) => {
  const seen = new Set<string>();
  for (const [i, scene] of m.scenes.entries()) {
    if (seen.has(scene.id) || scene.end <= scene.start || scene.end > m.duration ||
        (scene.videoFileId && (m.duration <= SHORT_VIDEO_SECONDS || scene.end - scene.start > MAX_EXPORT_SECONDS)) ||
        scene.shots.some((s) => s.time < scene.start || s.time > scene.end) ||
        !scene.shots.some((s) => s.fileId === scene.posterFileId)) {
      ctx.addIssue({ code: "custom", path: ["scenes", i], message: "場面の範囲・表紙・スクショが一致しません" });
    }
    seen.add(scene.id);
  }
});
export type SceneManifestData = z.infer<typeof SceneManifest>;

/** Range を Vercel の応答上限以内にする。ブラウザは続きの Range を取りに来る。 */
export function mediaRange(header: string | null, total: number) {
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  if (!header) return { start: 0, end: Math.min(total, MEDIA_CHUNK_BYTES) - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : total - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= total || end < start) return null;
  return { start, end: Math.min(end, total - 1, start + MEDIA_CHUNK_BYTES - 1) };
}

export function sceneTime(value: number) {
  const t = Math.max(0, Math.floor(value));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}
export function mediaSize(bytes: number | null) {
  return bytes == null ? "容量不明" : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function sceneProgressKey(tasks: { id: string; status: string }[]) {
  return tasks.map((t) => `${t.id}:${t.status}`).sort().join("|");
}

export type SceneMedia = { id: string; kind: string; fileSize: number | null; mimeType: string | null; previewId?: string };
export type SceneView = Omit<SceneManifestData["scenes"][number], "videoFileId" | "posterFileId" | "shots"> & {
  video: SceneMedia | null;
  poster: SceneMedia;
  shots: { time: number; media: SceneMedia }[];
};
export type VideoScenesView = {
  asset: { id: string; title: string; fileSize: number | null };
  duration: number | null;
  task: { id: string; status: string; error: string | null } | null;
  scenes: SceneView[];
  exports: { id: string; status: string; start: number; end: number; file: SceneMedia | null }[];
};
