import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ role: vi.fn(), workflow: vi.fn(), preview: vi.fn(), save: vi.fn(), restore: vi.fn(), revalidate: vi.fn(), invalidate: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.role }));
vi.mock("@/lib/domain/dossier-article-workflow", () => ({ requireDossierArticleWorkflow: mocks.workflow }));
vi.mock("@/lib/domain/dossier-article", () => ({ getDossierForArticle: vi.fn(), setDossierTemplate: vi.fn() }));
vi.mock("@/lib/domain/article-generate", () => ({ previewArticle: mocks.preview, saveArticle: mocks.save, restoreExclusions: mocks.restore }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/cache", () => ({ invalidateDossiers: mocks.invalidate }));
import { previewDossierArticleAction, restoreDossierExclusionsAction, saveDossierArticleAction } from "./actions";
const user = { id: "u1", role: "member", clearance: "internal" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.role.mockResolvedValue(user);
  mocks.preview.mockResolvedValue({ mode: "create" });
  mocks.save.mockResolvedValue({ ok: true, mode: "append", shortId: "short1", added: 2, sources: 1 });
  mocks.restore.mockResolvedValue(1);
});

describe.each(["dossier", "meetgreet", "live"])("共通画面から %s を操作する", (kind) => {
  const target = { kind, id: "resolved-server-side" };
  const preparation = kind === "dossier" ? null : { kind, href: `/${kind === "meetgreet" ? "meetgreets" : "lives"}/container1` };
  beforeEach(() => mocks.workflow.mockResolvedValue({ dossier: { id: "d1" }, target, preparation, article: { shortId: "short1" } }));
  it("プレビューはサーバーで解決した target を使う", async () => {
    const result = await previewDossierArticleAction("d1", null, []);
    expect(result.ok).toBe(true);
    expect(mocks.workflow).toHaveBeenCalledWith(user, "d1", null);
    expect(mocks.preview).toHaveBeenCalledWith(user, target, []);
    expect(mocks.role).toHaveBeenCalledWith(["admin", "member"]);
  });
  it("保存は digest と除外を渡し、ドシエ・記事・準備画面を更新する", async () => {
    expect((await saveDossierArticleAction("d1", null, "digest", [], null)).ok).toBe(true);
    expect(mocks.save).toHaveBeenCalledWith(user, target, "digest", [], null);
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    for (const path of ["/dossiers/d1", "/dossiers/d1/article", "/articles", "/articles/short1"]) expect(mocks.revalidate).toHaveBeenCalledWith(path);
    if (preparation) {
      expect(mocks.revalidate).toHaveBeenCalledWith(preparation.href);
      expect(mocks.revalidate).toHaveBeenCalledWith(kind === "meetgreet" ? "/meetgreets" : "/lives");
    }
  });
  it("除外の復元も同じ target に反映する", async () => {
    expect(await restoreDossierExclusionsAction("d1", null, ["asset:one"])).toEqual({ ok: true, restored: 1 });
    expect(mocks.restore).toHaveBeenCalledWith(user, target, ["asset:one"]);
  });
});

it("viewer は解決処理や生成処理へ到達しない", async () => {
  mocks.role.mockRejectedValue(new Error("Forbidden"));
  await expect(previewDossierArticleAction("d1", null)).rejects.toThrow("Forbidden");
  await expect(saveDossierArticleAction("d1", null)).rejects.toThrow("Forbidden");
  await expect(restoreDossierExclusionsAction("d1", null, [])).rejects.toThrow("Forbidden");
  expect(mocks.workflow).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});
it("権限や紐づけの検査が失敗したら生成・保存しない", async () => {
  mocks.workflow.mockRejectedValue(new Error("素材を閲覧できません"));
  expect(await previewDossierArticleAction("d1", null)).toEqual({ ok: false, error: "素材を閲覧できません" });
  expect(await saveDossierArticleAction("d1", null)).toEqual({ ok: false, error: "素材を閲覧できません" });
  expect(mocks.preview).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});
it("保存の競合が返った場合は成功として扱わず画面の状態を無効化しない", async () => {
  mocks.workflow.mockResolvedValue({ target: { kind: "dossier" } });
  mocks.save.mockResolvedValue({ ok: false, error: "素材が変わっています" });
  expect(await saveDossierArticleAction("d1", null, "stale")).toEqual({ ok: false, error: "素材が変わっています" });
  expect(mocks.revalidate).not.toHaveBeenCalled();
});
