/**
 * 文字起こしの本文を整える (#282)。DB を import しない純粋関数。
 *
 * 音声認識は無音・BGM だけのところに、学習データ (動画の字幕) 由来の決まり文句を作ることがある。
 * gpt-transcribe は区間ごとの確信度 (verbose_json) を返さないので、**文がまるごと決まり文句のときに限って**捨てる
 * (本人が文の中で「ご視聴ありがとうございました」と言ったものは残る)。
 *
 * gpt-transcribe は全体を 1 行で返すので、読みやすいように文ごとに改行する。
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
  return text.normalize("NFKC").replace(/[\s。、.,!！?？…・「」『』（）()]/g, "");
}

const HALLUCINATION_SET = new Set(HALLUCINATIONS.map(bare));

/** 決まり文句だけの文か。空の文も捨てる */
export function isHallucination(sentence: string): boolean {
  const t = bare(sentence);
  return !t || HALLUCINATION_SET.has(t);
}

const ENDS = new Set(["。", "！", "？", "!", "?"]);
const OPEN = new Set(["「", "『", "（", "("]);
const CLOSE = new Set(["」", "』", "）", ")"]);

/** 文末 (。！？) で区切る。かっこの中では区切らない (「楽しかった！」って言われた。は 1 文) */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    cur += c;
    if (OPEN.has(c)) depth++;
    else if (CLOSE.has(c)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && ENDS.has(c) && !ENDS.has(chars[i + 1] ?? "")) {
      out.push(cur);
      cur = "";
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** 決まり文句の文を捨て、文ごとに改行した本文。喋っていなければ空文字 */
export function cleanTranscript(text: string): string {
  return splitSentences(text)
    .filter((s) => !isHallucination(s))
    .join("\n")
    .trim();
}
