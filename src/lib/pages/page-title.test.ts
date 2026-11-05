import { describe, expect, it } from "vitest";

import { decodeHtml, extractTitle, isBlockedAddress } from "./page-title";

describe("extractTitle", () => {
  it("og:title を <title> より優先し、実体参照を戻す", () => {
    const html = `<html><head><title>別の題</title><meta property="og:title" content="靴下 &amp; 小物"/></head></html>`;
    expect(extractTitle(html)).toBe("靴下 & 小物");
  });

  it("og:title が無ければ <head> の <title>。本文の SVG の title は拾わない", () => {
    expect(extractTitle("<head><title>\n  商品ページ\n</title></head>")).toBe("商品ページ");
    expect(extractTitle("<head></head><body><svg><title>icon-account</title></svg></body>")).toBeNull();
    expect(extractTitle("<html><body><svg><title>icon-account</title></svg></body>")).toBeNull();
  });

  it("ボット避け・エラーのページの題は使わない", () => {
    expect(extractTitle("<head><title>Just a moment...</title></head>")).toBeNull();
    expect(extractTitle("<head><title>404 Not Found</title></head>")).toBeNull();
  });

  it("シングルクォートと name の og:title も読む", () => {
    expect(extractTitle(`<head><meta name='og:title' content='靴下'></head>`)).toBe("靴下");
  });

  it("DB や本文に載せられない文字を落とし、絵文字を割らずに切る", () => {
    expect(extractTitle("<head><title>A&#0;B</title></head>")).toBe("A B");
    expect(extractTitle("<head><title>A&#xD800;B</title></head>")).toBeNull();
    const cut = extractTitle(`<head><title>${"あ".repeat(119)}😀😀</title></head>`)!;
    expect(cut.isWellFormed()).toBe(true);
    expect(cut.endsWith("😀…")).toBe(true);
  });

  it("閉じない <title> や <meta を繰り返す入力でも時間をかけない", () => {
    const started = performance.now();
    expect(extractTitle("<title".repeat(170_000))).toBeNull();
    expect(extractTitle("<meta ".repeat(170_000))).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("長い題は切る", () => {
    expect(extractTitle(`<head><title>${"あ".repeat(200)}</title></head>`)).toBe(`${"あ".repeat(120)}…`);
  });
});

describe("decodeHtml", () => {
  it("meta の文字コードで読む", () => {
    const sjis = Uint8Array.from([0x3c, 0x6d, 0x65, 0x74, 0x61, 0x20, 0x63, 0x68, 0x61, 0x72, 0x73, 0x65, 0x74, 0x3d, 0x22, 0x53, 0x68, 0x69, 0x66, 0x74, 0x5f, 0x4a, 0x49, 0x53, 0x22, 0x3e, 0x82, 0xa0]);
    expect(decodeHtml(sjis, "text/html")).toContain("あ");
  });
});

describe("isBlockedAddress", () => {
  it("サーバーの内側のアドレスを止める", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it("URL が正規化した IPv4 射影の IPv6 も止める", () => {
    for (const host of ["[::ffff:127.0.0.1]", "[::ffff:a9fe:a9fe]", "[::ffff:a00:1]", "[::7f00:1]", "[64:ff9b::7f00:1]", "[2002:7f00:1::]", "[fec0::1]"]) {
      expect(isBlockedAddress(new URL(`http://${host}/`).hostname.replace(/^\[|\]$/g, ""))).toBe(true);
    }
    expect(isBlockedAddress("198.18.0.1")).toBe(true);
  });

  it("公開のアドレスは通す", () => {
    for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700::1111"]) expect(isBlockedAddress(ip)).toBe(false);
  });
});
