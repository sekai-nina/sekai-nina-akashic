import { cleanTranscript } from "./hallucination";

/**
 * OpenAI の音声文字起こし API (#282)。`POST /v1/audio/transcriptions` を素の `fetch` で叩く (SDK は入れない)。
 *
 * モデルは gpt-transcribe ($0.0045 / 音声 1 分。https://developers.openai.com/api/docs/models/gpt-transcribe,
 * 2026-11-14)。以前は Groq の whisper-large-v3 だったが、聞き違いが多く句読点も付かなかった。
 * mp4 / m4a のまま送れるので ffmpeg は要らない。
 *
 * **返せる形式は json / text だけ** (verbose_json は 400)。区間ごとの確信度が無いので、喋っていないところの
 * 決まり文句は文単位で捨てる (`hallucination.ts`)。
 */

export const TRANSCRIBE_MODEL = "gpt-transcribe";

/** OpenAI のアップロード上限 */
export const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024;

/** 20 秒前後のトークなら数秒で返る。長い動画でも 1 分あれば足りる */
export const TRANSCRIBE_TIMEOUT_MS = 90_000;

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

/** 録音の説明。無いと「ニーナは」が「今は」になった (2026-11-14 の試し) */
const PROMPT = "日向坂46 の坂井新奈のトーク";

/**
 * 聞き違えやすい言葉 (Groq のころ「五期生楽曲」が「ご規制楽曲」になった)。
 * **メンバーの名前は入れない。** 現役 27 人を入れたら、本人の一人称「ニーナ」が「りな」になり、
 * 「またかけるね」が「また食べるね」になった (2026-11-14 の試し)
 */
export const KEYWORDS = ["日向坂46", "坂井新奈", "四期生", "五期生", "ミーグリ", "おひさま", "ひなあい", "レッスン"];

export function isTranscribeConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY?.trim();
}

/**
 * OpenAI が受け付けなかった。`permanent` は同じファイルを送り直しても直らないもの (ファイルの形式・サイズ)。
 * それ以外は次の回にやり直す。`stopBatch` は、ほかのファイルを送っても同じ結果になるもの
 * (429・キーの誤り・ファイルと関係ない 400) で、cron はその回を打ち切る
 */
export class TranscribeError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    /** 429 (レート制限・残高切れ) で残りを送っても無駄に弾かれるだけ */
    readonly stopBatch = false,
  ) {
    super(message);
  }
}

export interface TranscribeResult {
  /** 決まり文句を捨て、文ごとに改行した本文。空文字なら喋っていない */
  text: string;
  /** 課金される秒数 (OpenAI の `usage.seconds`) */
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

/** OpenAI はファイル名の拡張子で形式を見る。分からなければ mp4 として送る */
export function fileNameFor(mimeType: string | null): string {
  return `audio.${(mimeType && EXTENSIONS[mimeType]) || "mp4"}`;
}

/**
 * 送り直しても直らないファイルの問題か。**400 をまとめて「ファイルのせい」にしない。** prompt・keywords が
 * 長すぎる・モデルが廃止された、のように要求のほうが悪い 400 でアセットを失敗にすると、cron が 15 件ずつ全件を
 * 「できなかった」にして対象から外してしまう。
 *
 * OpenAI の 400 は `error.param` で原因の引数を返す (音声トラックの無い動画は `param: "file"`、
 * `Audio file might be corrupted or unsupported`)
 */
export function isFileProblem(status: number, body: string): boolean {
  if (status === 413 || status === 415) return true;
  if (status !== 400) return false;
  try {
    const param = (JSON.parse(body) as { error?: { param?: unknown } }).error?.param;
    if (typeof param === "string") return param === "file";
  } catch {
    // JSON でなければ本文で見る
  }
  if (/prompt|keyword|model|api[_ ]key|parameter|response_format/i.test(body)) return false;
  return /file|audio|media|format|decod|duration/i.test(body);
}

export async function transcribeAudio(data: Buffer, mimeType: string | null): Promise<TranscribeResult> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new TranscribeError("OPENAI_API_KEY が未設定です", false, true);
  if (data.byteLength > TRANSCRIBE_MAX_BYTES) {
    throw new TranscribeError(`ファイルが ${Math.round(data.byteLength / 1024 / 1024)} MB で、25 MB を超えています`, true);
  }

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(data)]), fileNameFor(mimeType));
  form.append("model", TRANSCRIBE_MODEL);
  form.append("language", "ja");
  form.append("response_format", "json");
  form.append("temperature", "0");
  form.append("prompt", PROMPT);
  for (const k of KEYWORDS) form.append("keywords[]", k);

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
  } catch (e) {
    throw new TranscribeError(`OpenAI に届きませんでした: ${e instanceof Error ? e.message : String(e)}`, false);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    const permanent = isFileProblem(res.status, body);
    // 5xx は OpenAI の一時的な障害なので、次のファイルは通るかもしれない
    const stopBatch = !permanent && res.status < 500;
    throw new TranscribeError(`OpenAI が ${res.status} を返しました: ${body}`, permanent, stopBatch);
  }

  let json: { text?: string; usage?: { type?: string; seconds?: number } };
  try {
    json = (await res.json()) as typeof json;
  } catch (e) {
    throw new TranscribeError(`OpenAI の応答を読めませんでした: ${e instanceof Error ? e.message : String(e)}`, false);
  }
  const seconds = json.usage?.type === "duration" && typeof json.usage.seconds === "number" ? json.usage.seconds : 0;
  return { text: cleanTranscript(json.text ?? ""), billedSec: Math.ceil(seconds) };
}
