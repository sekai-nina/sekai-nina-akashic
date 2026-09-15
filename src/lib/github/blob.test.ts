import { describe, expect, it } from "vitest";

import { gitBlobSha } from "./blob";

describe("gitBlobSha", () => {
  // `git hash-object` で確かめられる既知の値
  it("空の blob", () => {
    expect(gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("hello (printf 'hello\\n' | git hash-object --stdin)", () => {
    expect(gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("長さは文字数ではなくバイト長で数える (マルチバイト)", () => {
    // "あ" は UTF-8 で 3 バイト。文字数 (1) で数えると値がずれる
    expect(gitBlobSha("あ")).toBe("0575c798f05a90ca8b3617062cd61648221d8a63");
    expect(gitBlobSha("あ")).toBe(gitBlobSha(Buffer.from("あ", "utf8")));
  });
});
