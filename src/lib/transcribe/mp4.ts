/**
 * MP4 / M4A (ISO BMFF) に音声トラックがあるかを、ボックスを辿るだけで判定する (#282)。デコードはしない。
 *
 * 画面だけで音声トラックの無い動画は、Groq に送っても `no_audio_stream` で返ってくるだけなので、
 * 送る前にここで落とす。`moov > trak > mdia > hdlr` の handler_type が `soun` のトラックを探す。
 * moov がファイル末尾にあっても全体をメモリに持っているので問題ない。
 *
 * 戻り値: true = 音声トラックあり / false = 無い / null = MP4 として読めない (判定せず Groq に任せる)
 */
export function mp4HasAudioTrack(data: Uint8Array): boolean | null {
  try {
    return findAudioTrack(new DataView(data.buffer, data.byteOffset, data.byteLength), data.byteLength);
  } catch (e) {
    // 途中で壊れていたら、その先に音声トラックがあるかもしれないので「無い」とは言わない
    if (e instanceof MalformedBox) return null;
    throw e;
  }
}

class MalformedBox extends Error {}

function findAudioTrack(view: DataView, length: number): boolean | null {
  const moov = findBox(view, 0, length, "moov");
  if (!moov) return null;
  let sawTrack = false;
  for (const trak of boxes(view, moov.start, moov.end, "trak")) {
    sawTrack = true;
    const mdia = findBox(view, trak.start, trak.end, "mdia");
    if (!mdia) continue;
    const hdlr = findBox(view, mdia.start, mdia.end, "hdlr");
    // hdlr は FullBox: version/flags (4) + pre_defined (4) の次が handler_type
    if (hdlr && hdlr.end - hdlr.start >= 12 && fourcc(view, hdlr.start + 8) === "soun") return true;
  }
  return sawTrack ? false : null;
}

interface Box {
  /** 中身の先頭 (ヘッダの直後) */
  start: number;
  end: number;
}

function fourcc(view: DataView, at: number): string {
  return String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
}

function* boxes(view: DataView, from: number, to: number, type: string): Generator<Box> {
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) throw new MalformedBox();
      // 64 bit のサイズ。上位 32 bit が立つほど大きいファイルは扱わない
      if (view.getUint32(at + 8) !== 0) throw new MalformedBox();
      size = view.getUint32(at + 12);
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) throw new MalformedBox();
    if (fourcc(view, at + 4) === type) yield { start: at + header, end: at + size };
    at += size;
  }
}

function findBox(view: DataView, from: number, to: number, type: string): Box | null {
  for (const b of boxes(view, from, to, type)) return b;
  return null;
}
