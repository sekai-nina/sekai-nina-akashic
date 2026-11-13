import { describe, expect, it } from "vitest";
import { cleanTranscript, isHallucination, splitSentences } from "./hallucination";

describe("isHallucination", () => {
  it("ふつうの発話は残す", () => {
    expect(isHallucination("今日はレッスンでした。")).toBe(false);
  });

  it("決まり文句だけの文は捨てる (句読点・空白の違いは無視)", () => {
    expect(isHallucination(" ご視聴ありがとうございました。")).toBe(true);
    expect(isHallucination("ご視聴ありがとうございました!")).toBe(true);
  });

  it("文の中の決まり文句は残す", () => {
    expect(isHallucination("配信のご視聴ありがとうございました、また明日")).toBe(false);
  });

  it("空の文は捨てる", () => {
    expect(isHallucination(" 。")).toBe(true);
  });
});

describe("splitSentences", () => {
  it("文末で区切り、かっこの中では区切らない", () => {
    expect(splitSentences("やっほー。「楽しかった！」って言われた。またね")).toEqual([
      "やっほー。",
      "「楽しかった！」って言われた。",
      "またね",
    ]);
  });

  it("連続した記号はまとめる", () => {
    expect(splitSentences("えっ!?本当に…。")).toEqual(["えっ!?", "本当に…。"]);
  });
});

describe("cleanTranscript", () => {
  it("文ごとに改行し、決まり文句の文を捨てる", () => {
    expect(cleanTranscript("おはよう。ご視聴ありがとうございました。また明日。")).toBe("おはよう。\nまた明日。");
  });

  it("全部捨てたら空文字", () => {
    expect(cleanTranscript("ご視聴ありがとうございました。")).toBe("");
    expect(cleanTranscript("")).toBe("");
  });
});
