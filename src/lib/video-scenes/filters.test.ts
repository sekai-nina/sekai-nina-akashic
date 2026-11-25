import { describe, expect, it } from "vitest";
import { parseSceneVideoKind, sceneVideoKindWhere } from "./filters";

describe("動画の場面の種類の絞り込み", () => {
  it("知らない値は絞り込みなしにする", () => {
    expect(parseSceneVideoKind("program")).toBe("program");
    expect(parseSceneVideoKind("x")).toBeNull();
    expect(parseSceneVideoKind(undefined)).toBeNull();
    expect(sceneVideoKindWhere(null)).toEqual({});
  });
  it("番組はトーク・TikTok・ゲームと重ならず、その他は全部の否定になる", () => {
    const program = JSON.stringify(sceneVideoKindWhere("program"));
    expect(program).toContain("Talk (Sony Music)");
    expect(program).toContain('"NOT"');
    const other = sceneVideoKindWhere("other") as { NOT: unknown[] };
    expect(other.NOT).toHaveLength(4);
  });
});

import { formatVideoDuration, parseSceneVideoLength, parseSceneVideoSort, sceneVideoLengthWhere, sceneVideoListHref } from "./filters";

describe("動画の場面の長さ・並び", () => {
  it("区切りは 60 秒・600 秒で、境目は長い側に入る", () => {
    expect(sceneVideoLengthWhere("short")).toEqual({ durationSec: { lt: 60 } });
    expect(sceneVideoLengthWhere("medium")).toEqual({ durationSec: { gte: 60, lt: 600 } });
    expect(sceneVideoLengthWhere("long")).toEqual({ durationSec: { gte: 600 } });
    expect(parseSceneVideoLength("x")).toBeNull();
    expect(parseSceneVideoSort("x")).toBe("new");
  });
  it("URL は既定値を書かず、組み合わせを保つ", () => {
    expect(sceneVideoListHref({ kind: null, length: null, sort: "new" })).toBe("/video-scenes");
    expect(sceneVideoListHref({ kind: "program", length: "long", sort: "longest" }, 2)).toBe("/video-scenes?kind=program&length=long&sort=longest&page=2");
  });
  it("長さは m:ss、1 時間以上は h:mm:ss", () => {
    expect(formatVideoDuration(1514.98)).toBe("25:15");
    expect(formatVideoDuration(2.869)).toBe("0:03");
    expect(formatVideoDuration(3725)).toBe("1:02:05");
    expect(formatVideoDuration(null)).toBeNull();
  });
});
