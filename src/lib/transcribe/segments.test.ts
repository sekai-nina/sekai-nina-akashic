import { describe, expect, it } from "vitest";
import { isHallucination, joinSegments, type WhisperSegment } from "./segments";

const seg = (text: string, over: Partial<WhisperSegment> = {}): WhisperSegment => ({
  text,
  start: 0,
  end: 1,
  avg_logprob: -0.2,
  no_speech_prob: 0.01,
  compression_ratio: 1.2,
  ...over,
});

describe("isHallucination", () => {
  it("ふつうの発話は残す", () => {
    expect(isHallucination(seg("今日はレッスンでした"))).toBe(false);
  });

  it("決まり文句だけの区間は捨てる (句読点・空白の違いは無視)", () => {
    expect(isHallucination(seg(" ご視聴ありがとうございました。"))).toBe(true);
    expect(isHallucination(seg("ご視聴ありがとうございました!"))).toBe(true);
  });

  it("文の中の決まり文句は残す", () => {
    expect(isHallucination(seg("配信のご視聴ありがとうございました、また明日"))).toBe(false);
  });

  it("no_speech と低い確信度がそろったら捨てる", () => {
    expect(isHallucination(seg("あー", { no_speech_prob: 0.9, avg_logprob: -1.5 }))).toBe(true);
    // 片方だけなら残す (Whisper 本体と同じ)
    expect(isHallucination(seg("あー", { no_speech_prob: 0.9, avg_logprob: -0.3 }))).toBe(false);
  });

  it("同じ語の繰り返しは捨てる", () => {
    expect(isHallucination(seg("はいはいはいはい", { compression_ratio: 3.1 }))).toBe(true);
  });

  it("空の区間は捨てる", () => {
    expect(isHallucination(seg(" 。"))).toBe(true);
  });
});

describe("joinSegments", () => {
  it("残った区間を改行でつなぐ", () => {
    expect(joinSegments([seg(" おはよう"), seg("ご視聴ありがとうございました"), seg("また明日 ")])).toBe(
      "おはよう\nまた明日",
    );
  });

  it("全部捨てたら空文字", () => {
    expect(joinSegments([seg("ご視聴ありがとうございました")])).toBe("");
  });
});
