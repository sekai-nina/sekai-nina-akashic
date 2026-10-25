import { describe, expect, it } from "vitest";
import { relocateExcerpt } from "./text-revision-relocate";

describe("relocateExcerpt", () => {
  it("旧範囲のままで一致するなら keep", () => {
    expect(relocateExcerpt("今日は晴れ。明日は雨。", "明日は雨", 6, 10)).toBe("keep");
  });

  it("前に文字が足されてずれたら新しい範囲を返す", () => {
    const content = "追記しました。今日は晴れ。明日は雨。";
    const r = relocateExcerpt(content, "明日は雨", 6, 10);
    expect(r).toEqual({ start: 13, end: 17 });
    if (r && r !== "keep") expect(content.slice(r.start, r.end)).toBe("明日は雨");
  });

  it("抜粋の部分が直されて見つからなければ null", () => {
    expect(relocateExcerpt("今日は晴れ。明後日は雨。", "明日は雨", 6, 10)).toBeNull();
  });

  it("2 か所以上あってどれか決められなければ null", () => {
    expect(relocateExcerpt("ありがとう。またね。ありがとう。", "ありがとう", 100, 105)).toBeNull();
  });

  it("画像プレースホルダは除いて照合する", () => {
    const content = "{{IMG:abc}}写真です。{{IMG:def}}";
    expect(relocateExcerpt(content, "写真です。", 11, 16)).toBe("keep");
  });

  it("範囲が本文の外でも探し直す", () => {
    expect(relocateExcerpt("短い本文", "本文", 50, 60)).toEqual({ start: 2, end: 4 });
  });

  it("空白の違いを無視して見つかった範囲は抜粋と一致しないので付け直さない", () => {
    expect(relocateExcerpt("前置き。明日は雨。\n\nまた", "明日は雨。\nまた", 0, 3)).toBeNull();
  });
});
