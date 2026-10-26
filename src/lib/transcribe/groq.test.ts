import { describe, expect, it } from "vitest";
import { fileNameFor, isFileProblem } from "./groq";

describe("isFileProblem", () => {
  it("サイズ・形式の拒否はファイルの問題", () => {
    expect(isFileProblem(413, "")).toBe(true);
    expect(isFileProblem(415, "")).toBe(true);
    expect(isFileProblem(400, '{"error":{"message":"could not decode audio file"}}')).toBe(true);
  });

  it("要求のほうが悪い 400 はファイルのせいにしない (全件が失敗扱いになるのを防ぐ)", () => {
    expect(isFileProblem(400, '{"error":{"message":"prompt is too long"}}')).toBe(false);
    expect(isFileProblem(400, '{"error":{"message":"The model `whisper-large-v3` has been decommissioned"}}')).toBe(false);
    expect(isFileProblem(400, '{"error":{"message":"something else"}}')).toBe(false);
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
