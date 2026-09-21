import { describe, expect, it } from "vitest";
import { deriveTitle, extractMemberNames } from "@/lib/tiktok/caption";

const ROSTER = [{ name: "坂井新奈" }, { name: "片山紗希" }, { name: "佐藤優羽" }, { name: "松尾桜" }];

describe("extractMemberNames", () => {
  it("絵文字付きのフルネームを拾い、名簿の順で返す", () => {
    const caption = "ありがとうございました💖📣 佐藤優羽🪽 片山紗希🐰 松尾桜🐧 #IRC_TGC #日向坂46";
    expect(extractMemberNames(caption, ROSTER)).toEqual(["片山紗希", "佐藤優羽", "松尾桜"]);
  });
  it("ハッシュタグの中の名前も拾う", () => {
    expect(extractMemberNames("#坂井新奈 の！🐏 『お願いバッハ！』", ROSTER)).toEqual(["坂井新奈"]);
  });
  it("何も無ければ空", () => {
    expect(extractMemberNames("", ROSTER)).toEqual([]);
    expect(extractMemberNames("#日向坂46_TikTok", ROSTER)).toEqual([]);
  });
});

describe("deriveTitle", () => {
  const t = new Date("2026-09-21T10:00:00Z");
  it("1 行目からハッシュタグを落とす", () => {
    expect(deriveTitle("「IRC」ありがとうございました💖 片山紗希🐰 #IRC_TGC #日向坂46\n2 行目", "h", t)).toBe(
      "「IRC」ありがとうございました💖 片山紗希🐰",
    );
  });
  it("タグだけの行を飛ばして本文の行を使う", () => {
    expect(deriveTitle("#日向坂46 #日向坂46_TikTok\n本文です", "h", t)).toBe("本文です");
  });
  it("ハッシュタグしか無ければ日付で組む (JST)", () => {
    expect(deriveTitle("#日向坂46 #日向坂46_TikTok", "hinatazakanews", new Date("2026-09-21T15:30:00Z"))).toBe(
      "@hinatazakanews 2026/09/22",
    );
  });
  it("80 文字で切る", () => {
    const long = "あ".repeat(100);
    expect(deriveTitle(long, "h", t)).toHaveLength(80);
    expect(deriveTitle(long, "h", t).endsWith("…")).toBe(true);
  });
  it("絵文字の途中で切らない (コードポイント単位)", () => {
    const title = deriveTitle("あ".repeat(78) + "💖💖💖", "h", t);
    expect(title.isWellFormed()).toBe(true);
    expect(Array.from(title)).toHaveLength(80);
    expect(title.endsWith("💖…")).toBe(true);
  });
  it("空行を飛ばして最初の実のある行を使う", () => {
    expect(deriveTitle("\n\n  本文  \n", "h", t)).toBe("本文");
  });
});
