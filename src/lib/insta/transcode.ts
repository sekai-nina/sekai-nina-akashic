import { execFile } from "node:child_process";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";

/**
 * Discord に添付するための動画の作り直し (#178)。
 *
 * Instagram の story 動画は VP9 で来ることが多く、Discord ではその場で再生できない。
 * 元の Asset (Drive の原本) はそのまま残し、**Discord に貼る用だけ** H.264 / AAC に変換する。
 * ついでに幅 720 に落として、ブースト無しのサーバの上限 (10MB) に収まるサイズを狙う。
 *
 * ffmpeg は `ffmpeg-static` のバイナリ (Vercel の Linux x64 でも動く)。実行権限が落ちている
 * 環境があるので、EACCES なら /tmp にコピーして chmod してから使う。
 */

const execFileAsync = promisify(execFile);

/** 幅の上限。story は 9:16 (1080x1920) なので 720x1280 になる */
const MAX_WIDTH = 720;
/** 画質。26〜28 で 15 秒の story が数 MB に収まる */
const CRF = "27";
/** 変換の打ち切り。長い story でも 1 分は超えない見込み */
const TIMEOUT_MS = 120_000;

export interface TranscodeResult {
  data: Buffer;
  filename: string;
  contentType: "video/mp4";
}

export function isTranscodeAvailable(): boolean {
  return typeof ffmpegPath === "string" && ffmpegPath.length > 0;
}

/**
 * H.264 / AAC の mp4 に変換して返す。失敗は例外 (呼び出し側は添付を諦めてリンクだけにする)。
 */
export async function transcodeForDiscord(input: Buffer, filename: string): Promise<TranscodeResult> {
  if (!isTranscodeAvailable()) throw new Error("ffmpeg が無い");
  const dir = await mkdtemp(path.join(tmpdir(), "insta-story-"));
  const inPath = path.join(dir, "in" + (path.extname(filename) || ".mp4"));
  const outPath = path.join(dir, "out.mp4");
  try {
    await writeFile(inPath, input);
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inPath,
      // 幅 720 に (縦横比維持。偶数に丸めないと libx264 が拒む)
      "-vf",
      `scale='min(${MAX_WIDTH},iw)':-2`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      CRF,
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      // ストリーミング再生用に moov を先頭へ (Discord のプレイヤーが即再生できる)
      "-movflags",
      "+faststart",
      outPath,
    ];
    await runFfmpeg(args);
    const data = await readFile(outPath);
    const base = path.basename(filename, path.extname(filename));
    return { data, filename: `${base}.mp4`, contentType: "video/mp4" };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

let runnablePath: string | null = null;

async function runFfmpeg(args: string[]): Promise<void> {
  const bin = runnablePath ?? (ffmpegPath as string);
  try {
    await execFileAsync(bin, args, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    runnablePath = bin;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EACCES" || runnablePath) {
      throw new Error(`ffmpeg に失敗: ${(e as { stderr?: string }).stderr?.slice(0, 300) || (e as Error).message}`);
    }
    // 実行権限が無い (デプロイ時に落ちる環境がある) → /tmp にコピーして付け直す
    const copy = path.join(tmpdir(), "ffmpeg-insta");
    await copyFile(bin, copy);
    await chmod(copy, 0o755);
    runnablePath = copy;
    await execFileAsync(copy, args, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  }
}
