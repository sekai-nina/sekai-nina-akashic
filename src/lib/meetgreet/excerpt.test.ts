import { describe, expect, it } from "vitest";

import { dropOverlapping, locateExcerpt, type ExcerptProposal } from "./excerpt";

const BODY = [
  "こんにちは！坂井新奈です🌱",
  "",
  "まずは先日の京都でのリアルミーグリ本当にありがとうございました！",
  "暑いなか会いに来てくださったこと、本当に嬉しかったです",
  "",
  "浴衣でした👘 ♡",
  "挑戦してみました！",
].join("\n");

describe("locateExcerpt", () => {
  it("原文そのままなら素直に見つける", () => {
    const pos = locateExcerpt(BODY, "浴衣でした👘 ♡");
    expect(pos).not.toBeNull();
    expect(BODY.slice(pos!.start, pos!.end)).toBe("浴衣でした👘 ♡");
  });

  it("改行が空白に潰れていても元の位置に戻せる", () => {
    // LLM が複数行を 1 行にして返すことがある
    const quote = "まずは先日の京都でのリアルミーグリ本当にありがとうございました！ 暑いなか会いに来てくださったこと、本当に嬉しかったです";
    const pos = locateExcerpt(BODY, quote);
    expect(pos).not.toBeNull();
    const got = BODY.slice(pos!.start, pos!.end);
    expect(got.startsWith("まずは先日の京都")).toBe(true);
    expect(got.endsWith("本当に嬉しかったです")).toBe(true);
    // 元の改行を含んだ範囲として返る
    expect(got).toContain("\n");
  });

  it("前後に空白が付いていても落とす", () => {
    const pos = locateExcerpt(BODY, "  挑戦してみました！  ");
    expect(pos).not.toBeNull();
    expect(BODY.slice(pos!.start, pos!.end)).toBe("挑戦してみました！");
  });

  it("言い換えられていたら採らない (null)", () => {
    // 要約されたもの・原文に無いものはズレた引用になるので拒否する
    expect(locateExcerpt(BODY, "京都のミーグリのお礼を述べている")).toBeNull();
    expect(locateExcerpt(BODY, "浴衣を着ました")).toBeNull();
  });

  it("空文字は null", () => {
    expect(locateExcerpt(BODY, "")).toBeNull();
    expect(locateExcerpt(BODY, "   ")).toBeNull();
  });
});

describe("dropOverlapping", () => {
  const mk = (start: number, end: number, text = "x"): ExcerptProposal => ({
    text,
    reason: "",
    start,
    end,
  });

  it("重なったら先に始まるほうを残す", () => {
    expect(dropOverlapping([mk(10, 20), mk(15, 30)]).map((e) => [e.start, e.end])).toEqual([[10, 20]]);
  });

  it("隣接 (end === start) は重なりではない", () => {
    expect(dropOverlapping([mk(0, 10), mk(10, 20)])).toHaveLength(2);
  });

  it("離れていれば位置順に全部残す", () => {
    expect(dropOverlapping([mk(40, 50), mk(0, 10)]).map((e) => e.start)).toEqual([0, 40]);
  });
});
