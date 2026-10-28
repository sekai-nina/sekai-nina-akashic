import { describe, expect, it } from "vitest";

import { analyzeRemark, isWholeLineupLive, matchSuLive, sectionOfOrder, toSetlistRows, type SuLive } from "./sakamichi-universe";

// 備考は Sakamichi Universe に実際にある書き方
describe("analyzeRemark", () => {
  const read = (r: string) => {
    const a = analyzeRemark(r);
    return [a.center, a.participated];
  };

  it("C坂井 / W センターはセンター (参加)", () => {
    expect(read("C坂井")).toEqual([true, true]);
    expect(read("C坂井・鶴崎")).toEqual([true, true]);
  });

  it("センターが別の人だけなら読めない", () => {
    expect(read("C大野・松尾")).toEqual([false, null]);
    expect(read("C蔵盛、 久美→小西、松田→竹内")).toEqual([false, null]);
  });

  it("坂井の名前・全員・5期生を含む期の指定は参加", () => {
    expect(read("C山口、2-4期生+坂井")).toEqual([false, true]);
    expect(read("平尾・蔵盛・坂井・鶴崎")).toEqual([false, true]);
    expect(read("C松田、全員")).toEqual([false, true]);
    expect(read("全員（バス）、加藤→正源司")).toEqual([false, true]);
    expect(read("5期生、C大野・松尾")).toEqual([false, true]);
    expect(read("C松田+5期生［フロント大田-松田-下田］、ワンハーフ")).toEqual([false, true]);
    expect(read("曲前正源司エレキギターソロ／C大野、髙橋・石塚・清水・正源司・平岡・山下・渡辺・坂井［メンバーシャッフルメドレー］")).toEqual([false, true]);
  });

  it("坂井の無い名前の並び・ソロ・5期生を含まない期・オリメンは不参加", () => {
    expect(read("C佐藤、大田・高井")).toEqual([false, false]);
    expect(read("大野・下田")).toEqual([false, false]);
    expect(read("2-4期生")).toEqual([false, false]);
    expect(read("高瀬+4期生、C高瀬・小西［高瀬愛奈卒業セレモニー：全メンバー登場］")).toEqual([false, false]);
    expect(read("OGを含む1期生（柿崎・齊藤を除く）［OGサプライズ登場］")).toEqual([false, false]);
    expect(read("山口ソロ、ワンハーフ")).toEqual([false, false]);
    expect(read("オリメン+清水・竹内・平岡・山下・渡辺")).toEqual([false, false]);
    expect(read("曲前大野NPC／C河田、金村・上村・森本・山口・大田・片山・蔵盛・鶴崎［メンバーシャッフルメドレー］")).toEqual([false, false]);
  });

  it("演出の説明だけ・文の中の名前は読めない", () => {
    expect(read("ワンハーフ")).toEqual([false, null]);
    expect(read("1番は小坂のソロ歌唱")).toEqual([false, null]);
    expect(read("歌唱中心アレンジ、クラップ、蔵盛・佐藤・下田・松尾はスタンドマイク")).toEqual([false, null]);
    expect(read("")).toEqual([false, null]);
  });
});

describe("sectionOfOrder", () => {
  it("EN / WEN をアンコールにする", () => {
    expect(sectionOfOrder("3.")).toBe("");
    expect(sectionOfOrder("EN1.")).toBe("アンコール");
    expect(sectionOfOrder("WEN1.")).toBe("Wアンコール");
  });
});

describe("matchSuLive", () => {
  const live = (livedate: string, starttime: string, extra: Partial<SuLive> = {}): SuLive => ({
    livedate,
    starttime,
    title: "t",
    stage: "s",
    html_url: "u",
    is_cancelled: false,
    ...extra,
  });

  it("同じ日が 1 つならそれ。中止は数えない", () => {
    const lives = [live("2026-09-06", "16:30:00", { is_cancelled: true }), live("2026-09-06", "20:00:00")];
    expect(matchSuLive({ date: "2026-09-06", label: "" }, lives).live?.starttime).toBe("20:00:00");
  });

  it("昼夜は公演の呼び分けで選び、選べなければ候補を返す", () => {
    const lives = [live("2025-11-15", "18:00:00"), live("2025-11-15", "13:30:00")];
    expect(matchSuLive({ date: "2025-11-15", label: "昼公演" }, lives).live?.starttime).toBe("13:30:00");
    expect(matchSuLive({ date: "2025-11-15", label: "夜公演" }, lives).live?.starttime).toBe("18:00:00");
    const none = matchSuLive({ date: "2025-11-15", label: "" }, lives);
    expect(none.live).toBeNull();
    expect(none.candidates).toHaveLength(2);
  });
});

describe("toSetlistRows", () => {
  it("備考で読めない曲だけ既定に任せ、センターは参加にする", () => {
    const rows = toSetlistRows(
      [
        { order: "1.", title: "キュン", remark: "C松尾" },
        { order: "2.", title: "ドレミソラシド", remark: "C坂井" },
        { order: "EN1.", title: "青春の馬", remark: "2-4期生" },
      ],
      () => ({ participated: false, reason: "既定" })
    );
    expect(rows.map((r) => [r.title, r.section, r.participated, r.center, r.reason])).toEqual([
      ["キュン", "", false, false, "既定"],
      ["ドレミソラシド", "", true, true, "備考にセンター坂井"],
      ["青春の馬", "アンコール", false, false, "備考: 2-4期生の曲"],
    ]);
  });
});

describe("isWholeLineupLive", () => {
  it("5 期生のライブとひなた坂46 LIVE は全員で全曲", () => {
    expect(isWholeLineupLive("五期生LIVE［DAY1］")).toBe(true);
    expect(isWholeLineupLive("新参者 二〇二五 LIVE at THEATER MILANO-Za〈5期生〉［1公演目］")).toBe(true);
    expect(isWholeLineupLive("17th Single ひなた坂46 LIVE［DAY1］")).toBe(true);
    expect(isWholeLineupLive("ARENA TOUR 2025「MONSTER GROOVE」［宮城①］")).toBe(false);
  });
});
