import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { cropBytes } from "./sketch";

/**
 * 左半分が赤・右半分が青の横長画像。`orientation` を渡すと Exif だけを付ける
 * (画素はそのまま = R2 のサムネイルが見せている向き)。
 */
async function twoTone(orientation?: number): Promise<Buffer> {
  const half = (r: number, b: number) =>
    sharp({ create: { width: 200, height: 200, channels: 3, background: { r, g: 0, b } } })
      .png()
      .toBuffer();
  const flat = await sharp({
    create: { width: 400, height: 200, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite([
      { input: await half(220, 0), left: 0, top: 0 },
      { input: await half(0, 220), left: 200, top: 0 },
    ])
    .jpeg()
    .toBuffer();
  return orientation ? sharp(flat).withMetadata({ orientation }).jpeg().toBuffer() : flat;
}

/** 切り出した画像の平均色 */
async function averageColor(bytes: Buffer): Promise<{ r: number; b: number }> {
  const px = await sharp(bytes).resize(1, 1, { fit: "fill" }).raw().toBuffer();
  return { r: px[0], b: px[2] };
}

describe("cropBytes", () => {
  it("囲った範囲を切り出す", async () => {
    const { r, b } = await averageColor(
      (await cropBytes(await twoTone(), { x: 0.5, y: 0, w: 0.5, h: 1 }))!
    );
    expect(b).toBeGreaterThan(r); // 右半分 = 青
  });

  it("枠は**正立**の画像に対する割合として当てる", async () => {
    // 画面が見るのは sketch-reference が返す正立の画像なので、ここも正立で測る。
    // orientation 6 の 400x200 は正立で 200x400 になり、右半分 = 元の上半分 = 赤
    const { r, b } = await averageColor(
      (await cropBytes(await twoTone(6), { x: 0.5, y: 0, w: 0.5, h: 1 }))!
    );
    expect(r).toBeGreaterThan(b);
  });

  it("切り出した画像は正立で返す (横倒しのまま送らない)", async () => {
    // 正立では 200x400。上半分を取ると 200x200
    const cut = (await cropBytes(await twoTone(6), { x: 0, y: 0, w: 1, h: 0.5 }))!;
    const meta = await sharp(cut).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(200);
  });

  it("切り出せない枠は null (切れないまま全体を送らない)", async () => {
    // **枠がある = 隣の人を送りたくない**なので、切れないなら 1 枚落とすほうが安全
    expect(await cropBytes(await twoTone(), { x: 0, y: 0, w: 0.001, h: 0.001 })).toBeNull();
  });

  it("壊れたバイト列でも落ちない", async () => {
    expect(await cropBytes(Buffer.from("not an image"), { x: 0, y: 0, w: 0.5, h: 1 })).toBeNull();
  });
});
