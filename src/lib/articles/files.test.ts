import { describe, expect, it } from "vitest";

import { parsePorcelainZ } from "./files";

describe("parsePorcelainZ", () => {
  it("通常の変更・未追跡はパスをそのまま返す", () => {
    expect(parsePorcelainZ(" M event/a.md\0?? event/新規.md\0")).toEqual(["event/a.md", "event/新規.md"]);
  });

  it("rename は移動先と移動元の 2 フィールドで、移動元は先頭を削らない", () => {
    expect(parsePorcelainZ("R  event/to.md\0attribute/from.md\0 M x.md\0")).toEqual([
      "event/to.md",
      "attribute/from.md",
      "x.md",
    ]);
  });

  it("空出力は空配列", () => {
    expect(parsePorcelainZ("")).toEqual([]);
  });
});
