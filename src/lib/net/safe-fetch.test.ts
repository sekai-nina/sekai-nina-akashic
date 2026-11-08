import { describe, expect, it } from "vitest";
import { checkFetchableUrl, isPublicAddress, safeFetch, SafeFetchError } from "./safe-fetch";

describe("isPublicAddress", () => {
  it("グローバルなアドレスは通す", () => {
    for (const a of ["8.8.8.8", "1.1.1.1", "142.250.196.110", "2606:4700:4700::1111"]) {
      expect(isPublicAddress(a), a).toBe(true);
    }
  });

  it("内部向けのアドレスは拒む (SSRF)", () => {
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::7f00:1",
      "64:ff9b::a00:1",
      "2002:a00:1::",
    ]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
  });

  it("IP でない文字列は拒む", () => {
    expect(isPublicAddress("localhost")).toBe(false);
  });
});

describe("checkFetchableUrl", () => {
  it("https の公開 URL は通す", () => {
    expect("url" in checkFetchableUrl("https://example.com/a.jpg")).toBe(true);
  });

  it.each([
    ["http://example.com/a.jpg"],
    ["file:///etc/passwd"],
    ["https://user:pw@example.com/a.jpg"],
    ["https://example.com:8443/a.jpg"],
    ["https://127.0.0.1/a.jpg"],
    ["https://[::1]/a.jpg"],
    ["https://169.254.169.254/latest/meta-data/"],
    ["not a url"],
  ])("%s は拒む", (url) => {
    expect("error" in checkFetchableUrl(url)).toBe(true);
  });
});

describe("safeFetch", () => {
  it("名前解決の先が内部向けなら接続しない", async () => {
    // localhost は必ずループバックに解決される
    await expect(safeFetch("https://localhost/a.jpg", { maxBytes: 1024, timeoutMs: 5000 })).rejects.toBeInstanceOf(
      SafeFetchError
    );
  });
});
