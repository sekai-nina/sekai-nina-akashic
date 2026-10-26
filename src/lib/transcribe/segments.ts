/**
 * Whisper の区間から「喋っていないのに出てきた文」を捨てる (#282)。DB を import しない純粋関数。
 *
 * Whisper は無音・BGM だけの区間に、学習データ (YouTube の字幕) 由来の決まり文句を作る。
 * 判定は Whisper 本体の no_speech 判定 (no_speech_prob > 0.6 かつ avg_logprob < -1) と、
 * 同じ語の繰り返し (compression_ratio > 2.4) と、よく出る決まり文句の完全一致。
 */

export interface WhisperSegment {
  text: string;
  start: number;
  end: number;
  avg_logprob: number;
  no_speech_prob: number;
  compression_ratio: number;
}

/** Whisper 本体 (openai/whisper の transcribe.py) と同じしきい値 */
const NO_SPEECH_THRESHOLD = 0.6;
const LOGPROB_THRESHOLD = -1;
const COMPRESSION_RATIO_THRESHOLD = 2.4;

/**
 * 無音・BGM で出る決まり文句。**区間がこれだけのときに限って**捨てる
 * (本人が文の中で「ご視聴ありがとうございました」と言ったものは残る)
 */
const HALLUCINATIONS = [
  "ご視聴ありがとうございました",
  "ご視聴ありがとうございます",
  "最後までご視聴頂きありがとうございました",
  "最後までご視聴いただきありがとうございました",
  "チャンネル登録をお願いいたします",
  "チャンネル登録よろしくお願いします",
  "字幕視聴ありがとうございました",
];

function bare(text: string): string {
  return text.normalize("NFKC").replace(/[\s。、.,!！?？…・「」]/g, "");
}

const HALLUCINATION_SET = new Set(HALLUCINATIONS.map(bare));

export function isHallucination(seg: WhisperSegment): boolean {
  const t = bare(seg.text);
  if (!t) return true;
  if (seg.no_speech_prob > NO_SPEECH_THRESHOLD && seg.avg_logprob < LOGPROB_THRESHOLD) return true;
  if (seg.compression_ratio > COMPRESSION_RATIO_THRESHOLD) return true;
  return HALLUCINATION_SET.has(t);
}

/** 残った区間をつないだ本文。喋っていなければ空文字 */
export function joinSegments(segments: WhisperSegment[]): string {
  return segments
    .filter((s) => !isHallucination(s))
    .map((s) => s.text.trim())
    .join("\n")
    .trim();
}
