import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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

export interface MediaStreams {
  hasVideo: boolean;
  hasAudio: boolean;
}

/**
 * ストリームの構成だけ見る (#201)。`ffprobe` は ffmpeg-static に入っていないので、
 * `ffmpeg -i` の標準エラーを読む (入力だけ指定すると情報を出して終了コード 1 で終わる)。
 *
 * Instagram は動画を **DASH で配る**ので、落ちてくるのは「映像だけの mp4」と「音声だけの mp4」に
 * 割れている。どちらなのかを知るために使う。
 */
export async function probeMedia(input: Buffer, filename: string): Promise<MediaStreams> {
  if (!isTranscodeAvailable()) throw new Error("ffmpeg が無い");
  const dir = await mkdtemp(path.join(tmpdir(), "insta-probe-"));
  const file = path.join(dir, "in" + (path.extname(filename) || ".mp4"));
  try {
    await writeFile(file, input);
    const out = await runFfmpegForOutput(["-hide_banner", "-i", file]);
    const streams = out.matchAll(/Stream #\d+:\d+[^\n]*?: (Video|Audio):/g);
    let hasVideo = false;
    let hasAudio = false;
    for (const m of streams) {
      if (m[1] === "Video") hasVideo = true;
      if (m[1] === "Audio") hasAudio = true;
    }
    return { hasVideo, hasAudio };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 映像だけの mp4 と音声だけの mp4 を 1 本にまとめる (#201)。再エンコードはしない
 * (原本の画質を落とさない。Discord 用の H.264 変換は `transcodeForDiscord` が別途やる)。
 */
export async function muxVideoAudio(video: Buffer, audio: Buffer, filename: string): Promise<Buffer> {
  if (!isTranscodeAvailable()) throw new Error("ffmpeg が無い");
  const dir = await mkdtemp(path.join(tmpdir(), "insta-mux-"));
  const vPath = path.join(dir, "v.mp4");
  const aPath = path.join(dir, "a.mp4");
  const outPath = path.join(dir, "out.mp4");
  try {
    await writeFile(vPath, video);
    await writeFile(aPath, audio);
    const args = (audioCodec: string) => [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      vPath,
      "-i",
      aPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      audioCodec,
      "-shortest",
      "-movflags",
      "+faststart",
      outPath,
    ];
    try {
      await runFfmpeg(args("copy"));
    } catch {
      // HE-AAC をそのまま入れられない容れ物のときは音声だけ詰め直す
      await runFfmpeg(args("aac"));
    }
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * ffmpeg が使えるか。**実体の有無まで見る。** パス文字列だけ見ていたせいで、
 * 関数にバイナリが入っていないのに true を返し、結合や変換が静かに飛ばされていた (#206)。
 */
export function isTranscodeAvailable(): boolean {
  return resolveFfmpeg() !== null;
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
      // iOS のプレイヤー (AVPlayer) は可変フレームレートや極端に低い fps を嫌う。
      // story は「静止画 + 音楽」で 1 fps のことがあるので固定 30 fps にそろえる
      // (同じ絵の繰り返しは x264 がほぼ無コストで潰すのでサイズは増えない)
      "-fps_mode",
      "cfr",
      "-r",
      "30",
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

/** 情報取得用。終了コードは見ず、標準エラーの内容を返す */
async function runFfmpegForOutput(args: string[]): Promise<string> {
  const bin = runnablePath ?? (resolveFfmpeg() as string);
  try {
    const { stderr } = await execFileAsync(bin, args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
    runnablePath = bin;
    return stderr;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "EACCES" && !runnablePath) {
      const copy = path.join(tmpdir(), "ffmpeg-insta");
      await copyFile(bin, copy);
      await chmod(copy, 0o755);
      runnablePath = copy;
      return runFfmpegForOutput(args);
    }
    // `-i` だけの実行は終了コード 1 になるが、標準エラーに情報が出ている
    if (err.stderr) return err.stderr;
    throw new Error(`ffmpeg に失敗: ${err.message}`);
  }
}

async function runFfmpeg(args: string[]): Promise<void> {
  const bin = runnablePath ?? (resolveFfmpeg() as string);
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

/**
 * 動画からサムネイル用のコマを 1 枚抜く (#205)。
 *
 * 動画のサムネイルは Drive が作ったものを使っているが、**上げた直後はまだ無い**ので
 * 登録時には取れず、ずっと空のままになっていた (実測 185 件)。実体が手元にある経路では
 * これで作る。
 */
export async function extractPoster(input: Buffer, filename: string): Promise<Buffer> {
  if (!isTranscodeAvailable()) throw new Error("ffmpeg が無い");
  const dir = await mkdtemp(path.join(tmpdir(), "insta-poster-"));
  const inPath = path.join(dir, "in" + (path.extname(filename) || ".mp4"));
  const outPath = path.join(dir, "out.jpg");
  try {
    await writeFile(inPath, input);
    const args = (seek: string | null) => [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      ...(seek ? ["-ss", seek] : []),
      "-i",
      inPath,
      "-frames:v",
      "1",
      "-vf",
      `scale='min(${MAX_WIDTH},iw)':-2`,
      "-q:v",
      "3",
      outPath,
    ];
    try {
      // 冒頭は暗転していることがあるので少し進めてから
      await runFfmpeg(args("1"));
      const data = await readFile(outPath);
      if (data.length > 0) return data;
    } catch {
      // 1 秒より短い動画 → 先頭から
    }
    await runFfmpeg(args(null));
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 実体の置き場の候補 (#206)。
 *
 * `require("ffmpeg-static")` が返すのは **ビルド時に焼き込まれたパス**で、Vercel の
 * 関数の中では存在しない (実測 `/ROOT/node_modules/.pnpm/…` / 実際は `/var/task/…`)。
 * バイナリは `outputFileTracingIncludes` で関数に入っているので、cwd から探し直す。
 */
function candidatePaths(): string[] {
  const out: string[] = [];
  for (const root of [process.cwd(), "/var/task"]) {
    out.push(path.join(root, "node_modules/ffmpeg-static/ffmpeg"));
    // pnpm の実体は版がパスに入るので走査する
    const store = path.join(root, "node_modules/.pnpm");
    try {
      for (const d of readdirSync(store)) {
        if (d.startsWith("ffmpeg-static@")) {
          out.push(path.join(store, d, "node_modules/ffmpeg-static/ffmpeg"));
        }
      }
    } catch {
      // .pnpm が無い配置もある
    }
  }
  return out;
}

/** 実際に実行できるパス。一度解決したら覚える */
let resolvedBin: string | null | undefined;

function resolveFfmpeg(): string | null {
  if (resolvedBin !== undefined) return resolvedBin;
  const cands = [typeof ffmpegPath === "string" ? ffmpegPath : null, ...candidatePaths()];
  resolvedBin = cands.find((c): c is string => !!c && existsSync(c)) ?? null;
  return resolvedBin;
}

export interface FfmpegDiagnostics {
  /** 実際に使うパス (解決できなければ ffmpeg-static が返した焼き込みパス) */
  path: string | null;
  /** 実体が見つかったか */
  exists: boolean;
  /** 実際に動かして取れた版（動かなければ null） */
  version: string | null;
  error: string | null;
}

/**
 * ffmpeg が**実際に動くか**まで確かめる (#206)。
 *
 * `isTranscodeAvailable()` はパス文字列が空でないかしか見ないので、バイナリが
 * バンドルに入っていなくても true を返す。本番でそれに気づけず、変換が静かに
 * 飛ばされていた。
 */
export async function ffmpegDiagnostics(): Promise<FfmpegDiagnostics> {
  const baked = typeof ffmpegPath === "string" && ffmpegPath.length > 0 ? ffmpegPath : null;
  const resolved = resolveFfmpeg();
  if (!resolved) {
    return {
      path: baked,
      exists: false,
      version: null,
      error: `実体が見つからない。候補=${candidatePaths().join(",")} / cwd=${process.cwd()}`,
    };
  }
  try {
    // `-version` は標準出力に出る (runFfmpegForOutput は標準エラーを返すので直に叩く)
    const { stdout } = await execFileAsync(resolved, ["-hide_banner", "-version"], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    return { path: resolved, exists: true, version: stdout.split("\n")[0]?.trim() || null, error: null };
  } catch (e) {
    return { path: resolved, exists: true, version: null, error: e instanceof Error ? e.message : String(e) };
  }
}
