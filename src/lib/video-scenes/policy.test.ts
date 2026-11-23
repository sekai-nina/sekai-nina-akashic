import { describe, expect, it } from "vitest";
import { ExportRange, SceneManifest, mediaRange, sceneTime, MEDIA_CHUNK_BYTES } from "./policy";

const manifest = (duration = 400) => ({ duration, scenes: [{ id: "one", start: 10, end: 30,
  videoFileId: "clip", posterFileId: "photo", shots: [{ fileId: "photo", time: 15 }] }] });

describe("保存範囲", () => {
  it("有限で正順の 90 秒以内だけ受け付ける", () => {
    expect(ExportRange.safeParse({ start: 0, end: 90 }).success).toBe(true);
    for (const range of [{ start: 0, end: 90.1 }, { start: 20, end: 20 }, { start: -1, end: 10 }, { start: 0, end: Infinity }, { start: NaN, end: 1 }]) {
      expect(ExportRange.safeParse(range).success).toBe(false);
    }
  });
});

describe("場面の生成結果", () => {
  it("長尺の500超の場面を受け付け、2000超は拒否する",()=>{
    const scenes=Array.from({length:2001},(_,i)=>({id:`s${i}`,start:i*40,end:i*40+30,videoFileId:`v${i}`,posterFileId:`p${i}`,shots:[{fileId:`p${i}`,time:i*40+15}]}));
    expect(SceneManifest.safeParse({duration:24000,scenes:scenes.slice(0,546)}).success).toBe(true);
    expect(SceneManifest.safeParse({duration:86400,scenes}).success).toBe(false);
  });
  it("短い動画にはスクショだけを受け付ける", () => {
    const short = manifest(180);
    expect(SceneManifest.safeParse(short).success).toBe(false);
    expect(SceneManifest.safeParse({ ...short, scenes: [{ ...short.scenes[0], videoFileId: null }] }).success).toBe(true);
  });
  it("動画外の範囲、範囲外のスクショ、表紙の不一致、重複 ID を拒否する", () => {
    const m = manifest();
    expect(SceneManifest.safeParse(m).success).toBe(true);
    for (const scene of [{ ...m.scenes[0], end: 401 }, { ...m.scenes[0], start: 16 },
      { ...m.scenes[0], posterFileId: "other" }, { ...m.scenes[0], end: 101 }]) {
      expect(SceneManifest.safeParse({ ...m, scenes: [scene] }).success).toBe(false);
    }
    expect(SceneManifest.safeParse({ ...m, scenes: [...m.scenes, ...m.scenes] }).success).toBe(false);
  });
  it("顔が見つからない動画も正常終了として持てる", () => {
    expect(SceneManifest.safeParse({ duration: 10, scenes: [] }).success).toBe(true);
  });
});

describe("ブラウザの Range", () => {
  it("開放端と大きな範囲を応答上限で区切る", () => {
    expect(mediaRange("bytes=0-", 10_000_000)).toEqual({ start: 0, end: MEDIA_CHUNK_BYTES - 1 });
    expect(mediaRange("bytes=4000000-9999999", 10_000_000)).toEqual({ start: 4_000_000, end: 7_999_999 });
    expect(mediaRange("bytes=8000000-", 10_000_000)).toEqual({ start: 8_000_000, end: 9_999_999 });
  });
  it("Safari などの末尾取得と小さい画像を扱う", () => {
    expect(mediaRange("bytes=-2", 100)).toEqual({ start: 98, end: 99 });
    expect(mediaRange(null, 100)).toEqual({ start: 0, end: 99 });
    expect(mediaRange("bytes=98-500", 100)).toEqual({ start: 98, end: 99 });
  });
  it("複数範囲、不正値、桁あふれ、EOF より後は拒否する", () => {
    for (const header of ["bytes=0-1,3-4", "bytes=-0", "bytes=-", "bytes=2-1", "bytes=100-", "bytes=999999999999999999999-", "other=0-1"]) {
      expect(mediaRange(header, 100)).toBe(null);
    }
    expect(mediaRange(null, 0)).toBe(null);
  });
  it("表示時刻を分秒で出す", () => expect(sceneTime(185.3)).toBe("3:05"));
});
