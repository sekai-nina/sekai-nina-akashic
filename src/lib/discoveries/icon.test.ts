import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { buildFoodIconPrompt, finishFoodIcon, FOOD_ICON_SIZE, foodIconKey } from "./icon";

describe("buildFoodIconPrompt", () => {
  it("名前と分類を入れ、指示が無ければ直す欄を付けない", () => {
    const p = buildFoodIconPrompt("たくあん", "主食・おかず");
    expect(p).toContain("「たくあん」のアイコンを1つだけ");
    expect(p).toContain("分類は「主食・おかず」");
    expect(p).not.toContain("直してほしい点");
  });

  it("人の指示を最後に足す (前後の空白は落とす)", () => {
    const p = buildFoodIconPrompt("もみじ饅頭", null, "  葉っぱではなくお饅頭に  ");
    expect(p).not.toContain("分類は");
    expect(p.endsWith("直してほしい点（必ず守る）:\n- 葉っぱではなくお饅頭に")).toBe(true);
  });
});

describe("foodIconKey", () => {
  it("名前はハッシュにし、時刻で作り直しごとに別の key にする", () => {
    const a = foodIconKey("みかん", 1);
    expect(a).toMatch(/^discoveries\/food-icons\/[0-9a-f]{12}-1\.webp$/);
    expect(foodIconKey("みかん", 2)).not.toBe(a);
    const hashOf = (k: string) => k.match(/([0-9a-f]{12})-/)?.[1];
    expect(hashOf(foodIconKey("醤油", 1))).not.toBe(hashOf(a));
  });
});

describe("finishFoodIcon", () => {
  it("何も描かれていない (全部透明な) 画像は失敗にする", async () => {
    const blank = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } })
      .png()
      .toBuffer();
    await expect(finishFoodIcon(blank)).rejects.toThrow("何も描かれていない");
  });

  it("透明な余白を切り、1 割の余白を付けた正方形にする (形は切らない)", async () => {
    // 1024x1024 の透明に、横長の赤い四角 (400x200) を左上寄りに置く
    const rect = await sharp({ create: { width: 400, height: 200, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } })
      .png()
      .toBuffer();
    const png = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: rect, left: 50, top: 100 }])
      .png()
      .toBuffer();

    const out = await finishFoodIcon(png);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("webp");
    expect([meta.width, meta.height]).toEqual([FOOD_ICON_SIZE, FOOD_ICON_SIZE]);

    // 四角は 400/448 の幅で中央に来る: 左右の端の列は透明、中央は赤
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
    expect(alphaAt(2, 128)).toBe(0);
    expect(alphaAt(FOOD_ICON_SIZE - 3, 128)).toBe(0);
    expect(alphaAt(128, 128)).toBeGreaterThan(200);
    // 横長なので上下には余白が多い
    expect(alphaAt(128, 40)).toBe(0);
  });
});
