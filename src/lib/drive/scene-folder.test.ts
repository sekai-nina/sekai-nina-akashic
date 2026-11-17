import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const get = vi.hoisted(() => vi.fn());
vi.mock("googleapis", () => ({ google: {
  auth: { OAuth2: class { setCredentials() {} }, GoogleAuth: class {} },
  drive: () => ({ files: { get } }),
} }));
import { isPrivateSceneFolder } from "./index";

beforeEach(() => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "test"); vi.stubEnv("GOOGLE_CLIENT_SECRET", "test"); vi.stubEnv("GOOGLE_REFRESH_TOKEN", "test");
  get.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
describe("場面素材の保存フォルダ", () => {
  it("リンク公開・ドメイン公開を受け付けない", async () => {
    for (const type of ["anyone", "domain"]) {
      get.mockResolvedValue({ data: { mimeType: "application/vnd.google-apps.folder", permissions: [{ type }] } });
      expect(await isPrivateSceneFolder("folder")).toBe(false);
    }
  });
  it("公開権限を検査できないフォルダも受け付けない", async () => {
    get.mockResolvedValue({ data: { mimeType: "application/vnd.google-apps.folder" } });
    expect(await isPrivateSceneFolder("folder")).toBe(false);
  });
  it("明示したアカウントだけが読めるフォルダを受け付ける", async () => {
    get.mockResolvedValue({ data: { mimeType: "application/vnd.google-apps.folder", permissions: [{ type: "user" }] } });
    expect(await isPrivateSceneFolder("folder")).toBe(true);
  });
});
