import { describe, expect, it } from "vitest";

import { guessMimeKind } from "@/lib/mime";

describe("guessMimeKind", () => {
  it("MIME の大分類で Asset.kind を決める", () => {
    expect(guessMimeKind("image/jpeg")).toBe("image");
    expect(guessMimeKind("video/quicktime")).toBe("video");
    expect(guessMimeKind("audio/mpeg")).toBe("audio");
    expect(guessMimeKind("text/plain")).toBe("text");
    expect(guessMimeKind("application/pdf")).toBe("document");
    expect(guessMimeKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("document");
    expect(guessMimeKind("application/octet-stream")).toBe("other");
  });
});
