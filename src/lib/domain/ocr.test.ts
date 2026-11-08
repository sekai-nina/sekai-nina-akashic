import { describe, expect, it, vi } from "vitest";

// ocr.ts は db.ts を読み込む。CI には DIRECT_URL が無く、PrismaClient の生成で落ちるので差し替える
vi.mock("@/lib/db", () => ({ prismaInternal: {}, withClearance: vi.fn() }));

import { ocrBlockedReason } from "./ocr";

const base = { kind: "image", storageProvider: "gdrive", storageKey: "drive-file-id", classification: "internal" } as const;

describe("ocrBlockedReason", () => {
  it("Drive にある internal 以下の画像は OCR できる", () => {
    expect(ocrBlockedReason(base)).toBeNull();
    expect(ocrBlockedReason({ ...base, classification: "public" })).toBeNull();
  });

  it("機密 (confidential 以上) は外部に送らない", () => {
    expect(ocrBlockedReason({ ...base, classification: "confidential" })).toMatch(/機密/);
    expect(ocrBlockedReason({ ...base, classification: "restricted" })).toMatch(/機密/);
  });

  it("画像以外と Drive に無いものは弾く", () => {
    expect(ocrBlockedReason({ ...base, kind: "video" })).toMatch(/画像ではありません/);
    expect(ocrBlockedReason({ ...base, storageKey: null })).toMatch(/Drive/);
    expect(ocrBlockedReason({ ...base, storageProvider: "local_none" })).toMatch(/Drive/);
  });
});
