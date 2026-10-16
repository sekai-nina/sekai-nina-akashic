import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DossierForArticle } from "./dossier-article";
const mocks = vi.hoisted(() => ({ dossier: vi.fn(), meetGreet: vi.fn(), live: vi.fn() }));
vi.mock("./dossier-article", () => ({
  getDossierForArticle: mocks.dossier,
  isContainerTemplate: (template: string) => template === "meetgreet" || template === "live",
}));
vi.mock("./meetgreets", () => ({ getMeetGreet: mocks.meetGreet, meetGreetTitle: () => "ミーグリ" }));
vi.mock("./lives", () => ({ getLive: mocks.live, livePeriodLabel: () => "2026/10/17" }));
vi.mock("./article-workflow", () => ({ WorkflowInputError: class extends Error {} }));
import { getDossierArticleWorkflow, requireDossierArticleWorkflow } from "./dossier-article-workflow";

const user = { id: "owner", role: "member", clearance: "internal" };
const article = { id: "a1", shortId: "short1", title: "記事", type: "event" as const, draft: false };
const dossier = (patch: Partial<DossierForArticle> = {}): DossierForArticle => ({
  id: "d1", title: "素材", kind: "general", ownerId: "owner", classification: "internal",
  viewMode: "clearance", editMode: "clearance", articleTemplate: "outing", articleExclusions: [], container: null, articles: [], ...patch,
});
const containerRow = (patch: Record<string, unknown> = {}) => ({
  id: "container1", dossierId: "d1", dossier: { id: "d1", itemCount: 4 }, classification: "internal",
  articleId: "a1", article, reports: { keep: 3 }, sketchKey: "sketch", needsSync: true,
  date: "2026-10-17", format: "online", single: "", label: "", venue: null, repoCollectionId: null, articleExclusions: [],
  name: "ライブ", note: "", performances: [], commonSongs: [], firstDate: null, lastDate: null, ...patch,
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.dossier.mockResolvedValue(dossier());
  mocks.meetGreet.mockResolvedValue(containerRow());
  mocks.live.mockResolvedValue(containerRow());
});

describe("一般ドシエの生成対象", () => {
  it("0本なら新規、1本なら既存記事へ追記し、器の詳細を読まない", async () => {
    expect(await getDossierArticleWorkflow(user, "d1")).toMatchObject({ target: { kind: "dossier", articleId: null }, article: null });
    mocks.dossier.mockResolvedValue(dossier({ articles: [article] }));
    expect(await getDossierArticleWorkflow(user, "d1")).toMatchObject({ target: { kind: "dossier", articleId: "a1" }, article });
    expect(mocks.meetGreet).not.toHaveBeenCalled();
    expect(mocks.live).not.toHaveBeenCalled();
  });
  it("複数の記事があるときは選択を求め、他ドシエの記事は選べない", async () => {
    mocks.dossier.mockResolvedValue(dossier({ articles: [article, { ...article, id: "a2" }] }));
    expect(await getDossierArticleWorkflow(user, "d1")).toMatchObject({ needsChoice: true, target: null });
    await expect(requireDossierArticleWorkflow(user, "d1", null)).rejects.toThrow("追記する記事を選んでください");
    expect(await requireDossierArticleWorkflow(user, "d1", "a2")).toMatchObject({ target: { kind: "dossier", articleId: "a2" } });
    await expect(getDossierArticleWorkflow(user, "d1", "foreign")).rejects.toThrow("このドシエに紐づいていません");
  });
  it("テンプレート未選択では生成せず、設定を求める", async () => {
    mocks.dossier.mockResolvedValue(dossier({ articleTemplate: null }));
    expect(await getDossierArticleWorkflow(user, "d1")).toMatchObject({ target: null });
    await expect(requireDossierArticleWorkflow(user, "d1", null)).rejects.toThrow("先にテンプレートを選んでください");
  });
});

describe.each(["meetgreet", "live"] as const)("%s の生成対象", (kind) => {
  beforeEach(() => mocks.dossier.mockResolvedValue(dossier({ articleTemplate: kind, container: { kind, id: "container1" } })));
  it("器の構造化メタと紐づく記事を使い、準備状況も返す", async () => {
    const result = await getDossierArticleWorkflow(user, "d1");
    expect(result).toMatchObject({ template: kind, articleId: "a1", article, needsChoice: false,
      target: { kind }, preparation: { kind, materialCount: 4, keptReports: 3, hasSketch: true, needsSync: true } });
    expect(result?.preparation?.href).toBe(`/${kind === "meetgreet" ? "meetgreets" : "lives"}/container1`);
  });
  it("既存記事が下書きであることを共通画面へ渡す", async () => {
    (kind === "meetgreet" ? mocks.meetGreet : mocks.live).mockResolvedValue(containerRow({ article: { ...article, draft: true } }));
    expect(await getDossierArticleWorkflow(user, "d1")).toMatchObject({ article: { draft: true } });
  });
  it("器に紐づかない記事を追記先に指定できない", async () => {
    await expect(getDossierArticleWorkflow(user, "d1", "foreign")).rejects.toThrow("ミーグリ・ライブに紐づく記事");
  });
  it("器が見えないときに一般ドシエ扱いへ逃がさない", async () => {
    (kind === "meetgreet" ? mocks.meetGreet : mocks.live).mockResolvedValue(null);
    await expect(getDossierArticleWorkflow(user, "d1")).rejects.toThrow("準備情報または素材を閲覧できません");
  });
  it("器のドシエが途中で変わった・見えなくなった場合に生成しない", async () => {
    const mock = kind === "meetgreet" ? mocks.meetGreet : mocks.live;
    mock.mockResolvedValue(containerRow({ dossierId: "another" }));
    await expect(getDossierArticleWorkflow(user, "d1")).rejects.toThrow("準備情報または素材を閲覧できません");
    mock.mockResolvedValue(containerRow({ dossier: null }));
    await expect(getDossierArticleWorkflow(user, "d1")).rejects.toThrow("準備情報または素材を閲覧できません");
  });
});

it("器がRLSで隠れても、テンプレートから生成の迂回を拒否する", async () => {
  mocks.dossier.mockResolvedValue(dossier({ container: null, articleTemplate: "meetgreet" }));
  await expect(getDossierArticleWorkflow(user, "d1")).rejects.toThrow("ミーグリ・ライブ情報を閲覧できない");
});
it("器とテンプレートの不整合を拒否する", async () => {
  mocks.dossier.mockResolvedValue(dossier({ articleTemplate: "outing", container: { kind: "live", id: "container1" } }));
  await expect(getDossierArticleWorkflow(user, "d1")).rejects.toThrow("一致していません");
});
it("クリッププールは直接記事にできない", async () => {
  mocks.dossier.mockResolvedValue(dossier({ kind: "clips" }));
  await expect(getDossierArticleWorkflow(user, "d1")).rejects.toThrow("プールは記事にできません");
});
it("viewer は所有者でも生成操作を実行できず、member も編集権限が必要", async () => {
  await expect(requireDossierArticleWorkflow({ ...user, role: "viewer" }, "d1", null)).rejects.toThrow("権限がありません");
  mocks.dossier.mockResolvedValue(dossier({ editMode: "private", ownerId: "other" }));
  expect(await getDossierArticleWorkflow(user, "d1")).toMatchObject({ editable: false });
  await expect(requireDossierArticleWorkflow(user, "d1", null)).rejects.toThrow("権限がありません");
});
it("ドシエと器の機密をそれぞれ検査する", async () => {
  mocks.dossier.mockResolvedValue(dossier({ classification: "confidential" }));
  await expect(getDossierArticleWorkflow(user, "d1")).rejects.toThrow("insufficient clearance");
  mocks.dossier.mockResolvedValue(dossier({ articleTemplate: "live", container: { kind: "live", id: "container1" } }));
  mocks.live.mockResolvedValue(containerRow({ classification: "confidential" }));
  await expect(getDossierArticleWorkflow(user, "d1")).rejects.toThrow("insufficient clearance");
});
it("見えないドシエは存在しない場合と同じ扱いにする", async () => {
  mocks.dossier.mockResolvedValue(null);
  expect(await getDossierArticleWorkflow(user, "hidden")).toBeNull();
  await expect(requireDossierArticleWorkflow(user, "hidden", null)).rejects.toThrow("見つかりません");
});
