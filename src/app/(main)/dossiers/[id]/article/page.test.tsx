import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), kind: vi.fn(), workflow: vi.fn(), queue: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/domain/dossiers", () => ({ getDossierKind: mocks.kind }));
vi.mock("@/lib/domain/dossier-article-workflow", () => ({ getDossierArticleWorkflow: mocks.workflow }));
vi.mock("@/lib/domain/article-workflow", () => ({ WorkflowInputError: class extends Error {} }));
vi.mock("@/lib/domain/dossier-article", () => ({ suggestTemplate: () => null }));
vi.mock("@/lib/article-workflow/templates", () => ({ selectableTemplates: () => [{ key: "outing" }], getTemplate: () => ({ needsAi: true }) }));
vi.mock("./ai-merge-step", () => ({ AiMergeStep: () => <p>AI組み込み</p> }));
vi.mock("@/components/workflow/article-step", () => ({ ArticleStep: () => <p>生成操作</p> }));
vi.mock("@/lib/domain/dossier-sync-queue", () => ({ listPendingDossiers: mocks.queue }));
vi.mock("./pending-clips", () => ({ PendingClips: () => <p>未反映の一覧</p> }));
vi.mock("./template-picker", () => ({ TemplatePicker: () => <p>テンプレート選択</p> }));
vi.mock("./actions", () => ({ previewDossierArticleAction: vi.fn(), saveDossierArticleAction: vi.fn(), restoreDossierExclusionsAction: vi.fn() }));
vi.mock("next/link", () => ({ default: ({ children, href, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a> }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not-found"); }, redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
import Page from "./page";
import { WorkflowInputError } from "@/lib/domain/article-workflow";

const props = { params: Promise.resolve({ id: "d1" }), searchParams: Promise.resolve({}) };
const workflow = (patch: Record<string, unknown> = {}) => ({
  dossier: { id: "d1", title: "素材", articles: [], articleTemplate: "outing" },
  template: "outing", preparation: null, editable: true, article: null, articleId: null, needsChoice: false, ...patch,
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "u1", role: "member", clearance: "internal" } });
  mocks.kind.mockResolvedValue("general");
  mocks.workflow.mockResolvedValue(workflow());
  mocks.queue.mockResolvedValue([]);
});
it("ミーグリ・ライブにも同じ生成操作を出し、準備画面へ戻れる", async () => {
  for (const kind of ["meetgreet", "live"]) {
    const href = `/${kind === "meetgreet" ? "meetgreets" : "lives"}/container1`;
    mocks.workflow.mockResolvedValue(workflow({ template: kind, preparation: { kind, href, title: "準備情報", period: "2026-10-17", materialCount: 4, keptReports: 3, hasSketch: true } }));
    const html = renderToStaticMarkup(await Page(props));
    expect(html).toContain("生成操作");
    expect(html).toContain(`href="${href}"`);
    expect(html).not.toContain("テンプレート選択");
  }
});
it("保存された記事の編集へ進め、公開確認リンクはadminだけに表示する", async () => {
  mocks.workflow.mockResolvedValue(workflow({ article: { id: "a1", shortId: "short1", title: "記事", draft: true } }));
  const memberHtml = renderToStaticMarkup(await Page(props));
  expect(memberHtml).toContain('href="/articles/short1/edit"');
  expect(memberHtml).not.toContain('href="/articles/push"');
  mocks.auth.mockResolvedValue({ user: { id: "u1", role: "admin", clearance: "internal" } });
  expect(renderToStaticMarkup(await Page(props))).toContain('href="/articles/push"');
});
it("閲覧のみの利用者にはプレビュー・保存を出さず、記事への参照を残す", async () => {
  mocks.workflow.mockResolvedValue(workflow({ editable: false, article: { id: "a1", shortId: "short1", title: "記事" } }));
  const html = renderToStaticMarkup(await Page(props));
  expect(html).not.toContain("生成操作");
  expect(html).toContain('href="/articles/short1"');
  expect(html).not.toContain('href="/articles/short1/edit"');
});
it("見えない器のエラーでは生成操作やテンプレート選択を表示しない", async () => {
  mocks.workflow.mockRejectedValue(new WorkflowInputError("準備情報を閲覧できません"));
  const html = renderToStaticMarkup(await Page(props));
  expect(html).toContain('role="alert"');
  expect(html).not.toContain("生成操作");
  expect(html).not.toContain("テンプレート選択");
});
it("クリップのプールから直接記事を生成しない", async () => {
  mocks.kind.mockResolvedValue("clips");
  await expect(Page(props)).rejects.toThrow("redirect:/clips");
  expect(mocks.workflow).not.toHaveBeenCalled();
});

const clip = { itemId: "i1", assetId: "x", title: "ブログ", kind: "blog", canonicalDate: null, excerpt: "", createdAt: new Date() };
const queued = (dossierId: string, title: string) => ({ dossierId, title, clips: [clip], latestAt: new Date() });

it("記事に載っていないクリップを出し、反映待ちの次の企画へ進める", async () => {
  mocks.queue.mockResolvedValue([queued("d0", "前"), queued("d1", "素材"), queued("d2", "クラシックバレエ")]);
  const html = renderToStaticMarkup(await Page(props));
  expect(html).toContain("未反映の一覧");
  expect(html).toContain('href="/dossiers/d2/article"');
  expect(html).toContain("クラシックバレエ");
});

it("片付いていまの企画が列から消えたら、反映待ちの先頭へ進める", async () => {
  mocks.queue.mockResolvedValue([queued("d0", "先頭"), queued("d2", "次")]);
  const html = renderToStaticMarkup(await Page(props));
  expect(html).not.toContain("未反映の一覧");
  expect(html).toContain('href="/dossiers/d0/article"');
});

it("反映待ちが無ければ案内を出さない", async () => {
  const html = renderToStaticMarkup(await Page(props));
  expect(html).not.toContain("反映待ちの企画");
});
