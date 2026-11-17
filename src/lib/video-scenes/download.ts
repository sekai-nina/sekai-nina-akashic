import { MAX_MEDIA_BYTES, MEDIA_CHUNK_BYTES, type SceneMedia } from "./policy";

export const sceneMediaUrl = (id: string) => `/api/video-scenes/media/${encodeURIComponent(id)}`;
export const sceneSourceUrl = (id: string) => `${sceneMediaUrl(id)}?source=1`;

/** 大きな動画も Vercel の応答上限を超えず、選んだファイルだけを取得する。 */
export async function fetchSceneDownload(file: SceneMedia, signal: AbortSignal, progress: (value: number) => void): Promise<Blob> {
  const total = file.fileSize;
  if (total == null || total <= 0 || total > MAX_MEDIA_BYTES) throw new Error("このファイルは保存できる容量を超えています");
  const parts: ArrayBuffer[] = [];
  for (let start = 0; start < total;) {
    const end = Math.min(total - 1, start + MEDIA_CHUNK_BYTES - 1);
    const response = await fetch(sceneMediaUrl(file.id), { signal, cache: "no-store", headers: { Range: `bytes=${start}-${end}` } });
    if (response.status !== 206 || response.headers.get("content-range") !== `bytes ${start}-${end}/${total}`) {
      throw new Error("ファイルを取得できませんでした。ログイン状態を確認してください");
    }
    const data = await response.arrayBuffer();
    if (data.byteLength !== end - start + 1) throw new Error("ファイルの取得が途中で止まりました");
    parts.push(data);
    start = end + 1;
    progress(Math.round(start / total * 100));
  }
  return new Blob(parts, { type: file.mimeType ?? "application/octet-stream" });
}

export function saveSceneBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
