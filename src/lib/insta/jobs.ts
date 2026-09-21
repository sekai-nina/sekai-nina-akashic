import type { InstaStoryJobStatus } from "@prisma/client";
import { HANDLE_PATTERN } from "@/lib/insta/targets";

/**
 * story ジョブ (#178) の純粋な部分。**DB を触らないモジュールに置く** (`targets.ts` と同じ理由:
 * テストが `@/lib/db` を巻き込むと DATABASE_URL の無い CI で落ちる)。
 *
 * ジョブの状態遷移・URL の検証・iPad に渡す入力・失効の判定をここに集め、
 * DB を触る側 (`src/lib/domain/insta-jobs.ts`) はこれを呼ぶだけにする。
 */

/** iPad ワーカー用キーに付ける permission。read / write を持たないキーで叩かせる */
export const WORKER_PERMISSION = "insta_worker";

/** まだ終わっていない状態。同じハンドルで新しいジョブを作らず既存を返す判定に使う */
export const ACTIVE_STATUSES: readonly InstaStoryJobStatus[] = ["pending", "dispatched", "processing"];

/** Pushcut に送ってから iPad が start を叩くまでの猶予。過ぎたら iPad が受け取れなかったとみなす */
export const DISPATCH_TIMEOUT_MS = 10 * 60 * 1000;
/** iPad が start してから complete / error までの猶予。Instagram Download は動画の変換で数分かかる */
export const PROCESSING_TIMEOUT_MS = 20 * 60 * 1000;
/** pending のまま送れない (Pushcut 未設定・iPad 不在) ジョブを諦めるまで。story 自体が 24h で消える */
export const PENDING_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * multipart で直接受ける上限。Vercel の本文上限 4.5MB (2026-08 時点の公式値、実測でも 413) の
 * 手前で止める。これを超えるものは Drive の resumable 経路で受ける
 */
export const MAX_DIRECT_UPLOAD_BYTES = 4 * 1024 * 1024;
/** Drive 経路で受け付けるファイルの上限。story の動画は長くても数十 MB */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;

/**
 * 受け付ける MIME。Instagram Download が落とすのは jpg / mp4 が主で、iPad 経由だと
 * heic / mov になることもある。それ以外 (html / json 等) はワーカーの取り違えなので弾く
 */
export const ALLOWED_MIME_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/quicktime",
];

/** 拡張子から MIME を補う。Shortcuts は `application/octet-stream` で送ってくることがある */
const EXTENSION_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
};

export class InstaJobError extends Error {
  constructor(
    message: string,
    /** API ルートがそのまま返す HTTP ステータス */
    readonly status: number = 400,
  ) {
    super(message);
  }
}

export interface ParsedStoryUrl {
  /** @ を除いた小文字のハンドル */
  handle: string;
  /** 正規化した URL。iPad にはこれを渡す */
  url: string;
  /** URL に story の ID が含まれていれば */
  storyId: string | null;
}

/**
 * story の URL を検証して正規化する。
 *
 * 受け付けるのは `https://www.instagram.com/stories/<handle>/` と
 * `https://www.instagram.com/stories/<handle>/<id>/` だけ。iPad の Shortcut に渡して
 * そのまま開かせる値なので、**instagram.com 配下の story 以外は通さない**
 * (任意の URL を iPad に開かせる口にしない)。
 *
 * ハンドルだけ渡されたら (bot は検知時にハンドルしか持たない) `stories/<handle>/` にする。
 */
export function parseStoryUrl(raw: string): ParsedStoryUrl {
  const input = raw.trim();
  if (!input) throw new InstaJobError("URL を入れてください");

  // ハンドル (`@name` 込み) だけならそのまま組み立てる
  const bare = input.replace(/^@/, "").toLowerCase();
  if (HANDLE_PATTERN.test(bare)) {
    return { handle: bare, url: storyUrlForHandle(bare), storyId: null };
  }

  let parsed: URL;
  try {
    // スキーム無しで貼られても拾う。http(s) 以外はホストの検査で落ちる
    parsed = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new InstaJobError(`URL の形式が不正です: ${raw}`);
  }
  const host = parsed.hostname;
  if (host !== "www.instagram.com" && host !== "instagram.com") {
    throw new InstaJobError("instagram.com の story URL だけ受け付けます");
  }
  const m = parsed.pathname.match(/^\/stories\/([^/]+)(?:\/(\d+))?\/?$/);
  if (!m) {
    throw new InstaJobError("story の URL (https://www.instagram.com/stories/<handle>/) だけ受け付けます");
  }
  const handle = m[1].toLowerCase();
  // ハイライトは /stories/highlights/<id>/ の形で、ハンドルの位置に "highlights" が来る
  if (handle === "highlights") {
    throw new InstaJobError("ハイライトの URL は受け付けません (stories/<handle>/ を渡してください)");
  }
  if (!HANDLE_PATTERN.test(handle)) {
    throw new InstaJobError(`ハンドルの形式が不正です: ${m[1]}`);
  }
  const storyId = m[2] ?? null;
  return { handle, url: storyId ? `${storyUrlForHandle(handle)}${storyId}/` : storyUrlForHandle(handle), storyId };
}

export function storyUrlForHandle(handle: string): string {
  return `https://www.instagram.com/stories/${handle}/`;
}

/** iPad のラッパー Shortcut が Shortcut Input として受け取る JSON */
export interface WorkerInput {
  jobId: string;
  url: string;
  handle: string;
}

export function buildWorkerInput(job: { id: string; url: string; handle: string }): string {
  const input: WorkerInput = { jobId: job.id, url: job.url, handle: job.handle };
  return JSON.stringify(input);
}

/** `InstaStoryJob.result` の形。result を受けるたびに files に追記する */
export interface InstaStoryJobFile {
  assetId: string;
  /** 既に同じ実体があった (SHA256 dedup)。Discord には添付しない */
  duplicate: boolean;
  driveFileId: string | null;
  filename: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
  receivedAt: string;
}

export interface InstaStoryJobResult {
  files: InstaStoryJobFile[];
}

/** DB の Json から読む。壊れていても落とさず空にする (人が読む一覧で 500 にしない) */
export function parseJobResult(raw: unknown): InstaStoryJobResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { files: [] };
  const files = (raw as { files?: unknown }).files;
  if (!Array.isArray(files)) return { files: [] };
  return {
    files: files.filter((f): f is InstaStoryJobFile => {
      if (!f || typeof f !== "object") return false;
      const x = f as Partial<InstaStoryJobFile>;
      return (
        typeof x.assetId === "string" &&
        typeof x.duplicate === "boolean" &&
        typeof x.filename === "string" &&
        typeof x.mimeType === "string" &&
        typeof x.fileSize === "number"
      );
    }),
  };
}

/**
 * 期限切れの判定。過ぎていれば failed にする理由を返す。
 *
 * - dispatched のまま start が来ない → iPad が受け取れなかった (Pushcut 未起動・圏外)
 * - processing のまま終わらない → Shortcut が途中で止まった (iPad の画面ロック等)
 * - pending のまま送れない → Pushcut 未設定か iPad がずっと不在。story は 24h で消える
 */
export function staleReason(
  job: { status: InstaStoryJobStatus; createdAt: Date; dispatchedAt: Date | null; startedAt: Date | null },
  now: Date,
): string | null {
  const t = now.getTime();
  switch (job.status) {
    case "dispatched": {
      const since = (job.dispatchedAt ?? job.createdAt).getTime();
      return t - since > DISPATCH_TIMEOUT_MS ? "iPad が受け取りませんでした (start が来ないまま 10 分)" : null;
    }
    case "processing": {
      const since = (job.startedAt ?? job.dispatchedAt ?? job.createdAt).getTime();
      return t - since > PROCESSING_TIMEOUT_MS ? "iPad が完了を報告しませんでした (20 分)" : null;
    }
    case "pending":
      return t - job.createdAt.getTime() > PENDING_TIMEOUT_MS ? "24 時間以内に iPad へ送れませんでした" : null;
    default:
      return null;
  }
}

/** MIME を正規化する。空や octet-stream なら拡張子から補い、許可リストに無ければ弾く */
export function resolveMimeType(mimeType: string | null | undefined, filename: string): string {
  let mime = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  if (!mime || mime === "application/octet-stream") {
    const ext = filename.toLowerCase().split(".").pop() ?? "";
    mime = EXTENSION_MIME[ext] ?? "";
  }
  if (!ALLOWED_MIME_TYPES.includes(mime)) {
    throw new InstaJobError(`受け付けない種類のファイルです: ${mimeType || "(不明)"} / ${filename}`, 415);
  }
  return mime;
}

/** Discord に添付する 1 ファイルの上限 (無料枠の 8MiB を下限に見る。bot 側と同じ) */
export const DISCORD_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Discord の 1 メッセージあたりの添付上限 */
export const DISCORD_MAX_FILES = 10;
/** Discord 本文と管理画面に並べる Asset リンクの上限 */
export const MAX_ASSET_LINKS = 5;
/** multipart に 4MB 超を送られたときの文言 (route と domain の両方で使う) */
export const DIRECT_UPLOAD_TOO_LARGE_MESSAGE =
  "multipart で受けられるのは 4MB までです。upload-url の経路を使ってください";

/**
 * complete 時の Discord 本文。添付できない (大きい / 重複) ものも本文の件数で分かるようにする。
 * `assetLinks` は新規に登録した Asset の URL (最大 MAX_ASSET_LINKS 件)
 */
export function formatCompletionMessage(input: {
  handle: string;
  url: string;
  files: InstaStoryJobFile[];
  assetLinks: string[];
}): string {
  const fresh = input.files.filter((f) => !f.duplicate);
  const dup = input.files.length - fresh.length;
  const head =
    fresh.length === 0
      ? `📸 story **${input.handle}**: 新しいコマはありませんでした (${input.files.length} 件は登録済み)`
      : `📸 story を保存 **${input.handle}** (新規 ${fresh.length} 件${dup ? ` / 登録済み ${dup} 件` : ""})`;
  const lines = [head, input.url, ...input.assetLinks];
  return lines.join("\n");
}
