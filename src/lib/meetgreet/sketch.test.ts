import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { padToCardAspect } from "./sketch";
import { buildSketchPrompt, SKETCH_PROMPT } from "./sketch-prompt";
import { maxReferencePhotos, MAX_IMAGE_INPUTS } from "./config";

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toBuffer();

describe("padToCardAspect", () => {
  it("1536x1024 を 1956x1024 (1.91:1) にする", async () => {
    const out = await padToCardAspect(await solid(1536, 1024));
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([1956, 1024]);
    expect(meta.width! / meta.height!).toBeCloseTo(1.91, 2);
  });

  it("足すのは左右だけで、生成物は切らない", async () => {
    const out = await padToCardAspect(await solid(1536, 1024));
    const meta = await sharp(out).metadata();
    expect(meta.height).toBe(1024); // 上下は触らない
    // 中央は元の色のまま、左端は白で埋まっている
    const center = await sharp(out).extract({ left: 978, top: 512, width: 1, height: 1 }).raw().toBuffer();
    const edge = await sharp(out).extract({ left: 0, top: 512, width: 1, height: 1 }).raw().toBuffer();
    expect([center[0], center[1], center[2]]).toEqual([10, 20, 30]);
    expect([edge[0], edge[1], edge[2]]).toEqual([255, 255, 255]);
  });

  it("既に 1.91:1 より横長なら何もしない", async () => {
    const src = await solid(2400, 1024);
    expect(await padToCardAspect(src)).toBe(src);
  });

  it("正方形でも 1.91:1 に揃う", async () => {
    const meta = await sharp(await padToCardAspect(await solid(1024, 1024))).metadata();
    expect([meta.width, meta.height]).toEqual([1956, 1024]);
  });

  it("画像として読めなければ例外", async () => {
    await expect(padToCardAspect(Buffer.from("not an image"))).rejects.toThrow();
  });
});

describe("参照枚数の上限", () => {
  it("基準スケッチのぶんを差し引く", () => {
    expect(maxReferencePhotos(false)).toBe(MAX_IMAGE_INPUTS - 1);
  });

  it("作り直しでは直す候補のぶんもう 1 枚減る (合計が上限を超えない)", () => {
    // 写真 + 直す候補 + 基準スケッチ <= MAX_IMAGE_INPUTS
    expect(maxReferencePhotos(true) + 1 + 1).toBeLessThanOrEqual(MAX_IMAGE_INPUTS);
  });
});

describe("buildSketchPrompt", () => {
  it("追加指示が無ければ元のまま", () => {
    expect(buildSketchPrompt("")).toBe(SKETCH_PROMPT);
    expect(buildSketchPrompt("   ")).toBe(SKETCH_PROMPT);
  });

  it("追加指示は末尾に足す (元の指示は消さない)", () => {
    const out = buildSketchPrompt("中央はツインテールで");
    expect(out.startsWith(SKETCH_PROMPT)).toBe(true);
    expect(out).toContain("中央はツインテールで");
  });

  it("プロンプトの要となる指示が消えていない", () => {
    // 画像の並び順 (最後が基準スケッチ) と 1.91:1 は実装側が前提にしている。
    // 編集時にうっかり落ちると、生成物が静かに別物になる
    for (const anchor of ["最後の1枚", "1.91:1", "白背景", "禁止事項", "顔は描かない"]) {
      expect(SKETCH_PROMPT).toContain(anchor);
    }
  });
});
