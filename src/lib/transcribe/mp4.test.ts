import { describe, expect, it } from "vitest";
import { mp4HasAudioTrack } from "./mp4";

/** type と中身からボックスを組む */
function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const body = children.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(8 + body);
  new DataView(out.buffer).setUint32(0, 8 + body);
  out.set(new TextEncoder().encode(type), 4);
  let at = 8;
  for (const c of children) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** hdlr: version/flags (4) + pre_defined (4) + handler_type (4) + reserved (12) + name */
function hdlr(handler: string): Uint8Array {
  const body = new Uint8Array(25);
  body.set(new TextEncoder().encode(handler), 8);
  return box("hdlr", body);
}

const track = (handler: string) => box("trak", box("tkhd", new Uint8Array(4)), box("mdia", box("mdhd", new Uint8Array(4)), hdlr(handler)));
const ftyp = box("ftyp", new TextEncoder().encode("isom"));

describe("mp4HasAudioTrack", () => {
  it("音声トラックがあれば true", () => {
    expect(mp4HasAudioTrack(new Uint8Array([...ftyp, ...box("moov", track("vide"), track("soun"))]))).toBe(true);
  });

  it("映像トラックだけなら false", () => {
    expect(mp4HasAudioTrack(new Uint8Array([...ftyp, ...box("moov", track("vide"))]))).toBe(false);
  });

  it("moov がファイル末尾 (mdat の後) にあっても読む", () => {
    const mdat = box("mdat", new Uint8Array(100));
    expect(mp4HasAudioTrack(new Uint8Array([...ftyp, ...mdat, ...box("moov", track("soun"))]))).toBe(true);
  });

  it("MP4 でなければ null (判定せず Groq に任せる)", () => {
    expect(mp4HasAudioTrack(new TextEncoder().encode("ID3 not an mp4 file at all"))).toBeNull();
    expect(mp4HasAudioTrack(new Uint8Array(0))).toBeNull();
  });

  it("壊れたサイズでも例外にしない", () => {
    const broken = box("moov", track("soun"));
    new DataView(broken.buffer).setUint32(0, 9999);
    expect(mp4HasAudioTrack(new Uint8Array([...ftyp, ...broken]))).toBeNull();
  });
});
