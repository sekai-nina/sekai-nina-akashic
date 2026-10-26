import { describe, expect, it } from "vitest";

import { deriveLiveSongs, parseSetlistText } from "./setlist";

describe("parseSetlistText", () => {
  it("M1 / EN1 の番号を落とし、EN をアンコールにする", () => {
    const text = "M1 円周率\nM2 どこまでが道なんだ？\nMC\nM3 ホントの時間\nEN1 ママのドレス\nEN2 My fans";
    expect(parseSetlistText(text)).toEqual([
      { title: "円周率", section: "" },
      { title: "どこまでが道なんだ？", section: "" },
      { title: "ホントの時間", section: "" },
      { title: "ママのドレス", section: "アンコール" },
      { title: "My fans", section: "アンコール" },
    ]);
  });

  it("見出し行から後ろをその区切りにする (Wアンコールも)", () => {
    const text = "01. Overture\n02. キツネ\n\n-ENCORE-\n03. JOYFUL LOVE\n【Wアンコール】\nEmpty";
    expect(parseSetlistText(text)).toEqual([
      { title: "キツネ", section: "" },
      { title: "JOYFUL LOVE", section: "アンコール" },
      { title: "Empty", section: "Wアンコール" },
    ]);
  });

  it("数字で始まる曲名は削らない。番号の後ろに区切りがあるときだけ落とす", () => {
    expect(parseSetlistText("21世紀の曲\n3曲目 キュン\n4) 青春の馬").map((l) => l.title)).toEqual([
      "21世紀の曲",
      "キュン",
      "青春の馬",
    ]);
  });

  it("1 行の「A / B / C」も受け、同じ曲の再披露は 2 行のまま", () => {
    expect(parseSetlistText("Empty / 円周率 / Empty").map((l) => l.title)).toEqual(["Empty", "円周率", "Empty"]);
  });

  it("注記 (※) と空行は落とす", () => {
    expect(parseSetlistText("※センターは坂井新奈\n\nキュン\n")).toEqual([{ title: "キュン", section: "" }]);
  });
});

describe("deriveLiveSongs", () => {
  const s = (songId: string, participated = true, center = false) => ({ songId, participated, center });

  it("参加した曲の共通部分が共通披露曲、残りが追加曲。出ていない曲は落とす", () => {
    const out = deriveLiveSongs(
      [
        { id: "p1", setlist: [s("a"), s("b", false), s("c"), s("x", true, true)], legacySongs: [], legacyCenter: [] },
        { id: "p2", setlist: [s("a"), s("c"), s("y"), s("x", true, true)], legacySongs: [], legacyCenter: [] },
      ],
      []
    );
    expect(out.common).toEqual(["a", "c", "x"]);
    expect(out.performances).toEqual([
      { id: "p1", songs: [], centerSongs: ["x"] },
      { id: "p2", songs: ["y"], centerSongs: ["x"] },
    ]);
  });

  it("センター曲は参加に外れていても参加扱い", () => {
    const out = deriveLiveSongs([{ id: "p1", setlist: [s("a", false, true)], legacySongs: [], legacyCenter: [] }], []);
    expect(out.common).toEqual(["a"]);
  });

  it("セトリの無い公演は従来の手入力 (共通 + 追加) をその公演の曲とみなす", () => {
    const out = deriveLiveSongs(
      [
        { id: "p1", setlist: [s("a"), s("b"), s("d")], legacySongs: [], legacyCenter: [] },
        { id: "p2", setlist: null, legacySongs: ["c"], legacyCenter: ["a"] },
      ],
      ["a", "b"]
    );
    expect(out.common).toEqual(["a", "b"]);
    expect(out.performances).toEqual([
      { id: "p1", songs: ["d"], centerSongs: [] },
      { id: "p2", songs: ["c"], centerSongs: ["a"] },
    ]);
  });

  it("再披露 (同じ曲が 2 行) は 1 曲に数える", () => {
    const out = deriveLiveSongs([{ id: "p1", setlist: [s("a"), s("b"), s("a")], legacySongs: [], legacyCenter: [] }], []);
    expect(out.common).toEqual(["a", "b"]);
  });
});

describe("parseSetlistText (表記のゆれ)", () => {
  it("飾りの付いた MC / VTR、箇条書きの印、全角の番号、番号の無い EN を読む", () => {
    const text = "Ｍ１ キュン\n〜MC〜\n・青春の馬\nVTR（自己紹介）\nEN キツネ\nENCORE 2\n-MC-";
    expect(parseSetlistText(text)).toEqual([
      { title: "キュン", section: "" },
      { title: "青春の馬", section: "" },
      { title: "キツネ", section: "アンコール" },
    ]);
  });

  it("EN の後ろの番号の無い行もアンコール。半角の / は前後に空白が無ければ割らない", () => {
    expect(parseSetlistText("M1 A\nEN1 B\nC")).toEqual([
      { title: "A", section: "" },
      { title: "B", section: "アンコール" },
      { title: "C", section: "アンコール" },
    ]);
    expect(parseSetlistText("1/2").map((l) => l.title)).toEqual(["1/2"]);
  });

  it("M / E で始まる曲名 (Empty) は削らない", () => {
    expect(parseSetlistText("Empty\nMy fans").map((l) => l.title)).toEqual(["Empty", "My fans"]);
  });
});
