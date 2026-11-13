import { describe, expect, it } from "vitest";
import { fileNameFor, isFileProblem } from "./openai";

const openAiError = (message: string, param: string | null) =>
  JSON.stringify({ error: { message, type: "invalid_request_error", param, code: "invalid_value" } });

describe("isFileProblem", () => {
  it("サイズ・形式の拒否はファイルの問題", () => {
    expect(isFileProblem(413, "")).toBe(true);
    expect(isFileProblem(415, "")).toBe(true);
    // 音声トラックの無い動画を送ったときの実際の応答 (2026-11-14)
    expect(isFileProblem(400, openAiError("Audio file might be corrupted or unsupported", "file"))).toBe(true);
    // 長すぎる音声は model を含むが、ファイルの問題 (全件を止めない)
    expect(
      isFileProblem(400, openAiError("audio duration 1556 seconds is longer than 1500 seconds which is the maximum for this model", null)),
    ).toBe(true);
  });

  it("要求のほうが悪い 400 はファイルのせいにしない (全件が失敗扱いになるのを防ぐ)", () => {
    expect(
      isFileProblem(400, openAiError("response_format 'verbose_json' is not compatible with model 'gpt-transcribe'.", "response_format")),
    ).toBe(false);
    expect(isFileProblem(400, openAiError("keywords is too long (audio)", "keywords"))).toBe(false);
    expect(isFileProblem(400, openAiError("something else", null))).toBe(false);
  });

  it("JSON でなければ本文で見る", () => {
    expect(isFileProblem(400, "could not decode audio file")).toBe(true);
    expect(isFileProblem(400, "The model `gpt-transcribe` does not exist")).toBe(false);
  });

  it("429・5xx・401 はファイルの問題ではない", () => {
    expect(isFileProblem(429, "audio file")).toBe(false);
    expect(isFileProblem(500, "")).toBe(false);
    expect(isFileProblem(401, "")).toBe(false);
  });
});

describe("fileNameFor", () => {
  it("mimeType から拡張子を決める。分からなければ mp4", () => {
    expect(fileNameFor("audio/mp4")).toBe("audio.m4a");
    expect(fileNameFor("video/mp4")).toBe("audio.mp4");
    expect(fileNameFor(null)).toBe("audio.mp4");
  });
});
