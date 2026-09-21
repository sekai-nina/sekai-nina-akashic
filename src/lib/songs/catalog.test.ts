import { describe, expect, it } from "vitest";

import {
  groupEditions,
  isCdDisc,
  isSongTrack,
  normalizeArtist,
  parseJsonp,
  stripEditionSuffix,
  stripUnitCredit,
  toDateString,
  type CatalogDetail,
} from "./catalog";
import { normalizeSongTitle } from "./normalize";

function edition(code: string, title: string, discs: CatalogDetail["discs"], over: Partial<CatalogDetail> = {}): CatalogDetail {
  return {
    representative_goods_number: code,
    title,
    type: "シングル",
    artistName: "日向坂46",
    release_date: "2026.01.28",
    discs,
    ...over,
  };
}
const cd = (tracks: string[], discNo = 1, title = ""): CatalogDetail["discs"][number] => ({
  disc_number: discNo,
  title,
  contents: tracks.map((t, i) => ({ track_number: i + 1, title: t })),
});

describe("normalizeSongTitle", () => {
  it("全角・記号・空白・大文字の違いを吸収し、数字 (2020 版) は残す", () => {
    expect(normalizeSongTitle("HEY！OHISAMA！")).toBe(normalizeSongTitle("HEY!OHISAMA!"));
    expect(normalizeSongTitle("Am I ready?")).toBe("amiready");
    expect(normalizeSongTitle("ブルーベリー＆ラズベリー")).toBe("ブルーベリーラズベリー");
    expect(normalizeSongTitle("誰よりも高く跳べ！ 2020")).not.toBe(normalizeSongTitle("誰よりも高く跳べ！"));
  });
});

describe("catalog helpers", () => {
  it("parseJsonp はコールバックの中身を返す", () => {
    expect(parseJsonp<{ a: number }>('disco_index({"a":1});')).toEqual({ a: 1 });
  });
  it("CD のディスクだけ数える (初回盤の disc 2 は Blu-ray、2 枚組は DISC2／CD)", () => {
    expect(isCdDisc({ disc_number: 1, title: "" })).toBe(true);
    expect(isCdDisc({ disc_number: 1, title: "DISC1／CD" })).toBe(true);
    expect(isCdDisc({ disc_number: 2, title: "" })).toBe(false);
    expect(isCdDisc({ disc_number: 2, title: "DISC2／Blu-ray" })).toBe(false);
    expect(isCdDisc({ disc_number: 2, title: "DISC2／CD" })).toBe(true);
  });
  it("off vocal / Overture / ライブ音源は曲に数えない", () => {
    expect(isSongTrack("クリフハンガー off vocal ver.")).toBe(false);
    expect(isSongTrack("Overture")).toBe(false);
    expect(isSongTrack("キュン (Instrumental)")).toBe(false);
    expect(isSongTrack("キュン (Inst)")).toBe(false);
    expect(isSongTrack("JOYFUL LOVE(Live from Happy Train Tour 2023)")).toBe(false);
    expect(isSongTrack("君と生きる")).toBe(true);
    // 単語の一部の inst は落とさない
    expect(isSongTrack("Instead of you")).toBe(true);
  });
  it("ユニット曲のメンバー名の括弧を落とす (数字・英字を含む括弧や 1 語は残す)", () => {
    expect(stripUnitCredit("Cage（東村芽依 金村美玖 河田陽菜 丹生明里）")).toBe("Cage");
    expect(stripUnitCredit("やさしさが邪魔をする（加藤史帆 渡邉美穂 上村ひなの）")).toBe("やさしさが邪魔をする");
    expect(stripUnitCredit("誰よりも高く跳べ！ (2020)")).toBe("誰よりも高く跳べ！ (2020)");
    expect(stripUnitCredit("まさか 偶然…（新曲）")).toBe("まさか 偶然…（新曲）");
    expect(stripUnitCredit("キュン")).toBe("キュン");
  });
  it("盤の表記を落とす", () => {
    expect(stripEditionSuffix("クリフハンガー【初回仕様限定盤 TYPE-A】")).toBe("クリフハンガー");
    expect(stripEditionSuffix("イチャイチャ虫[通常盤]")).toBe("イチャイチャ虫");
    expect(stripEditionSuffix("ひなたざか【初回仕様限定盤(豪華版)TYPE-A】")).toBe("ひなたざか");
    expect(stripEditionSuffix("Kind of love")).toBe("Kind of love");
  });
  it("発売日とアーティスト名を揃える", () => {
    expect(toDateString("2026.1.8")).toBe("2026-01-08");
    expect(normalizeArtist("けやき坂46（日向坂46）")).toBe("けやき坂46");
    expect(normalizeArtist("日向坂46")).toBe("日向坂46");
  });
});

describe("groupEditions", () => {
  it("TYPE-A〜通常盤を 1 作品にまとめ、収録曲は和集合、代表品番は通常盤", () => {
    const a = edition("SRCL-13520", "クリフハンガー【初回仕様限定盤 TYPE-A】", [
      cd(["クリフハンガー", "君と生きる", "好きになるクレッシェンド", "クリフハンガー off vocal ver."]),
      cd(["Overture", "NO WAR in the future 2020"], 2),
    ]);
    const b = edition("SRCL-13522", "クリフハンガー【初回仕様限定盤 TYPE-B】", [
      cd(["クリフハンガー", "君と生きる", "涙目の太陽"]),
    ]);
    const regular = edition("SRCL-13528", "クリフハンガー", [cd(["クリフハンガー", "君と生きる", "涙目の太陽"])]);
    const bd = edition("SRXL-1", "ライブ Blu-ray", [cd(["Overture", "キュン"])], { type: "BD" });

    const [r] = groupEditions([b, regular, a, bd]);
    expect(groupEditions([b, regular, a, bd])).toHaveLength(1);
    expect(r.title).toBe("クリフハンガー");
    expect(r.kind).toBe("single");
    expect(r.sonyCode).toBe("SRCL-13528");
    expect(r.releaseDate).toBe("2026-01-28");
    expect(r.editions.map((e) => e.code)).toEqual(["SRCL-13520", "SRCL-13522", "SRCL-13528"]);
    expect(r.tracks.map((t) => t.title)).toEqual(["クリフハンガー", "君と生きる", "好きになるクレッシェンド", "涙目の太陽"]);
    // 初回盤の disc 2 (Blu-ray 相当) の曲は入らない
    expect(r.tracks.some((t) => t.title.includes("NO WAR"))).toBe(false);
    expect(r.tracks.find((t) => t.title === "涙目の太陽")?.editions).toEqual(["SRCL-13522", "SRCL-13528"]);
    expect(r.tracks.find((t) => t.title === "クリフハンガー")?.trackNo).toBe(1);
  });

  it("実際の API の形 (discs が 1 トラック 1 要素、初回盤の disc 2 は題なし) でも同じに畳む", () => {
    const track = (discNo: number, no: number, title: string, discTitle = "") => ({
      disc_number: discNo,
      title: discTitle,
      contents: [{ track_number: no, title }],
    });
    const a = edition("SRCL-1", "テスト【TYPE-A】", [
      track(1, 1, "曲A"),
      track(1, 2, "曲A off vocal ver."),
      track(2, 1, "Overture"),
      track(2, 2, "ライブの曲"),
    ]);
    const [r] = groupEditions([a]);
    expect(r.tracks.map((t) => t.title)).toEqual(["曲A"]);
    // 通常盤の詳細が無ければ最初の盤が代表 (詳細が取れない盤は discs: [] で渡される)
    expect(r.sonyCode).toBe("SRCL-1");
    const [r2] = groupEditions([a, edition("SRCL-3", "テスト", [])]);
    expect(r2.sonyCode).toBe("SRCL-3");
    expect(r2.tracks.map((t) => t.title)).toEqual(["曲A"]);
  });

  it("Sony が誤って album にしている 17th「Kind of love」は single に直す", () => {
    const k = edition("SRCL-13718", "Kind of love", [cd(["Kind of love"])], { type: "アルバム", release_date: "2026.05.20" });
    expect(groupEditions([k])[0].kind).toBe("single");
  });

  it("作品名が同じでも発売日が違えば別の作品 (再発盤)", () => {
    const x = edition("A-1", "キュン", [cd(["キュン"])], { release_date: "2019.03.27" });
    const y = edition("A-2", "キュン", [cd(["キュン"])], { release_date: "2020.03.27" });
    expect(groupEditions([x, y])).toHaveLength(2);
  });
});
