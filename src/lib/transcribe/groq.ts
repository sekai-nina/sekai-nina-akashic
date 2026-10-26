import { MEMBERS } from "@/lib/members";
import { joinSegments, type WhisperSegment } from "./segments";

/**
 * Groq の音声文字起こし API (#282)。OpenAI 互換の `POST /openai/v1/audio/transcriptions`。
 * 素の `fetch` で叩く (SDK は入れない)。
 *
 * 単価は whisper-large-v3 で $0.111 / 音声 1 時間、**1 回あたり最低 10 秒**の課金
 * (https://groq.com/pricing, 2026-10-27)。mp4 / m4a のまま送れるので ffmpeg は要らない。
 *
 * **2026-10-27 時点は無料枠** (Developer プランへの切り替えが Groq 側で止まっていた)。
 * 上限は 20 回 / 分・2,000 回 / 日・音声 7,200 秒 / 時間・28,800 秒 / 日・25 MB。
 * トークは 1 件 20 秒前後なので足りる。/costs には有料の単価で出る (無料枠のうちは実際には 0 円)。
 */

export const GROQ_TRANSCRIBE_MODEL = "whisper-large-v3";

/** Groq に送れるファイルの上限 (無料枠の上限。有料枠は 100 MB だが、Vercel のメモリに載せるので低めに保つ) */
export const GROQ_MAX_BYTES = 25 * 1024 * 1024;

/** Groq は 1 回あたり最低 10 秒分を課金する */
export const GROQ_MIN_BILLED_SEC = 10;

const ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";

/**
 * prompt は 224 トークンまで。現役メンバーの名前と、聞き違えやすい言葉だけにして収める
 * (「五期生楽曲」が「ご規制楽曲」になった。2026-10-27 の試し)
 */
const PROMPT = `日向坂46。四期生、五期生、おひさま、ミーグリ。${MEMBERS.filter((m) => !m.graduated)
  .map((m) => m.name)
  .join("、")}。`;

export function isGroqConfigured(): boolean {
  return !!process.env.GROQ_API_KEY?.trim();
}

/**
 * Groq が受け付けなかった。`permanent` は同じファイルを送り直しても直らないもの (形式・サイズ)。
 * それ以外 (429・5xx・キーの誤り・通信) は次の回にやり直す
 */
export class GroqTranscribeError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    /** 429。無料枠は 20 回 / 分・音声 7,200 秒 / 時間までなので、cron はここで打ち切る */
    readonly rateLimited = false,
  ) {
    super(message);
  }
}

export interface TranscribeResult {
  /** 喋っていない区間を捨てた本文。空文字なら喋っていない */
  text: string;
  /** 音声の長さ (秒) */
  durationSec: number;
  /** 課金される秒数 (最低 10 秒に切り上げ) */
  billedSec: number;
}

const EXTENSIONS: Record<string, string> = {
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/flac": "flac",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mp4",
};

/** Groq はファイル名の拡張子で形式を見る。分からなければ mp4 として送る */
export function fileNameFor(mimeType: string | null): string {
  return `audio.${(mimeType && EXTENSIONS[mimeType]) || "mp4"}`;
}

export async function transcribeWithGroq(data: Buffer, mimeType: string | null): Promise<TranscribeResult> {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) throw new GroqTranscribeError("GROQ_API_KEY が未設定です", false);
  if (data.byteLength > GROQ_MAX_BYTES) {
    throw new GroqTranscribeError(`ファイルが ${Math.round(data.byteLength / 1024 / 1024)} MB で、25 MB を超えています`, true);
  }

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(data)]), fileNameFor(mimeType));
  form.append("model", GROQ_TRANSCRIBE_MODEL);
  form.append("language", "ja");
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  form.append("prompt", PROMPT);

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    throw new GroqTranscribeError(`Groq に届きませんでした: ${e instanceof Error ? e.message : String(e)}`, false);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    // 音声トラックの無い動画 (BGM も無い画面だけのもの) は「喋っていない」と同じ扱いにする
    if (res.status === 400 && body.includes("no_audio_stream")) return { text: "", durationSec: 0, billedSec: 0 };
    // 400 / 413 / 415 は形式・サイズの問題で、送り直しても直らない。401 / 403 はキーの問題なのでアセット側は失敗にしない
    const permanent = res.status === 400 || res.status === 413 || res.status === 415;
    throw new GroqTranscribeError(`Groq が ${res.status} を返しました: ${body}`, permanent, res.status === 429);
  }

  const json = (await res.json()) as { text?: string; duration?: number; segments?: WhisperSegment[] };
  const durationSec = typeof json.duration === "number" && json.duration > 0 ? json.duration : 0;
  return {
    text: json.segments ? joinSegments(json.segments) : (json.text ?? "").trim(),
    durationSec,
    billedSec: Math.max(GROQ_MIN_BILLED_SEC, Math.ceil(durationSec)),
  };
}
