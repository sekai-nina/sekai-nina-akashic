import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("./actions", () => ({ generateVideoScenes: vi.fn(), exportVideoScene: vi.fn() }));
vi.stubGlobal("React", React);
import { VideoSceneBoard } from "./scene-board";
import type { VideoScenesView } from "@/lib/video-scenes/policy";

const initial: VideoScenesView = {
  asset: { id: "source", title: "テスト動画", fileSize: 100_000_000 }, duration: 600,
  task: { id: "task", status: "ready", error: null }, exports: [], scenes: [{ id: "s", start: 10, end: 30,
    poster: { id: "photo", previewId: "thumb", kind: "image", mimeType: "image/jpeg", fileSize: 1000 },
    video: { id: "clip", kind: "video", mimeType: "video/mp4", fileSize: 1_000_000 },
    shots: [{ time: 15, media: { id: "photo", previewId: "thumb", kind: "image", mimeType: "image/jpeg", fileSize: 1000 } }],
  }],
};
describe("動画の場面の画面", () => {
  it("同じ場面に動画とスクショをまとめ、一覧では小さい表紙だけを読む", () => {
    const html = renderToStaticMarkup(<VideoSceneBoard initial={initial} editable />);
    expect(html).toContain("場面から探す");
    expect(html).toContain("20 秒を保存");
    expect(html).toContain("/api/video-scenes/media/thumb");
    expect(html).not.toContain('src="/api/video-scenes/media/photo"');
    expect(html).toContain('preload="none"');
    expect(html).not.toContain('href="/api/video-scenes/media/source');
  });
  it("viewer には生成・範囲の書き出し操作を出さない", () => {
    const html = renderToStaticMarkup(<VideoSceneBoard initial={{ ...initial, task: null }} editable={false} />);
    expect(html).not.toContain("場面候補を作る");
    expect(html).not.toContain("この範囲の動画を準備");
    expect(html).toContain("このコマを保存");
  });
  it("別の端末でも準備済みの範囲と実容量が分かる", () => {
    const html = renderToStaticMarkup(<VideoSceneBoard initial={{ ...initial, exports: [{ id: "e", start: 15, end: 25, status: "ready", file: { id: "export", kind: "video", fileSize: 2_000_000, mimeType: "video/mp4" } }] }} editable />);
    expect(html).toContain("保存用に準備した動画");
    expect(html).toContain("2.0 MB");
  });
});
