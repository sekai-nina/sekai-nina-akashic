import { describe, expect, it } from "vitest";

import { dropOverlapping, locateExcerpt } from "./excerpt";
import type { ExcerptProposal } from "./types";

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

  it("同じ言い回しが 2 回出てくるとき、from で 2 つめを取れる", () => {
    // ブログは「ありがとうございました！」のような定型句を繰り返す。毎回 0 から
    // 探すと 2 つめの抜粋が 1 つめと同じ場所に解決してしまう
    const body = "ありがとうございました！\n\n別の話です。\n\nありがとうございました！";
    const first = locateExcerpt(body, "ありがとうございました！");
    expect(first).toEqual({ start: 0, end: 12 });
    const second = locateExcerpt(body, "ありがとうございました！", first!.end);
    expect(second!.start).toBeGreaterThan(first!.end);
    expect(body.slice(second!.start, second!.end)).toBe("ありがとうございました！");
  });

  it("from より後ろに無ければ null", () => {
    expect(locateExcerpt(BODY, "浴衣でした👘 ♡", BODY.length - 3)).toBeNull();
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

  it("重なったら長いほうを残す (先に始まるかどうかでは決めない)", () => {
    expect(dropOverlapping([mk(10, 20), mk(15, 30)]).map((e) => [e.start, e.end])).toEqual([[15, 30]]);
  });

  it("隣接 (end === start) は重なりではない", () => {
    expect(dropOverlapping([mk(0, 10), mk(10, 20)])).toHaveLength(2);
  });

  it("離れていれば位置順に全部残す", () => {
    expect(dropOverlapping([mk(40, 50), mk(0, 10)]).map((e) => e.start)).toEqual([0, 40]);
  });

  it("重なったら長いほうを残す (短い一文が長い振り返りを追い出さない)", () => {
    // 先に始まる短い文 (100-130) が、それを含む長い抜粋 (120-600) を消さないこと
    expect(dropOverlapping([mk(100, 130), mk(120, 600)]).map((e) => [e.start, e.end])).toEqual([
      [120, 600],
    ]);
  });

  it("開始位置が同じなら長いほうを残す", () => {
    expect(dropOverlapping([mk(100, 120), mk(100, 400)]).map((e) => e.end)).toEqual([400]);
  });
});
