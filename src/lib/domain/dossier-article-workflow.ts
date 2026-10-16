/** ドシエを入口として、一般・ミーグリ・ライブの記事生成先を解決する (#233 段階2)。 */
import type { ArticleTemplate } from "@prisma/client";
import { canEditDossier } from "@/lib/auth/dossier-permissions";
import { assertClearance } from "@/lib/classification";
import type { ArticleTarget } from "./article-generate";
import { WorkflowInputError, type ActingUser } from "./article-workflow";
import { getDossierForArticle, isContainerTemplate, type DossierForArticle } from "./dossier-article";
import { getMeetGreet, meetGreetTitle } from "./meetgreets";
import { getLive, livePeriodLabel } from "./lives";

export interface WorkflowArticle {
  id: string;
  shortId: string;
  title: string;
  draft: boolean;
}

export interface ArticlePreparation {
  kind: "meetgreet" | "live";
  href: string;
  title: string;
  period: string;
  materialCount: number;
  keptReports: number;
  hasSketch: boolean;
  needsSync: boolean;
}

export interface DossierArticleWorkflow {
  dossier: DossierForArticle;
  target: ArticleTarget | null;
  template: ArticleTemplate | null;
  article: WorkflowArticle | null;
  articleId: string | null;
  needsChoice: boolean;
  editable: boolean;
  preparation: ArticlePreparation | null;
}

/** 閲覧時にも対象を確定する。見えない器を一般ドシエとして扱わない。 */
export async function getDossierArticleWorkflow(
  user: ActingUser, dossierId: string, chosenArticleId: string | null = null,
): Promise<DossierArticleWorkflow | null> {
  const dossier = await getDossierForArticle(user, dossierId);
  if (!dossier) return null;
  if (dossier.kind === "clips") throw new WorkflowInputError("クリップのプールは記事にできません");
  assertClearance(user.clearance, dossier.classification);
  const editable = ["admin", "member"].includes(user.role) && canEditDossier(user, dossier);
  const common = { dossier, editable };
  const container = dossier.container;
  if (!container && isContainerTemplate(dossier.articleTemplate)) {
    throw new WorkflowInputError("この素材のミーグリ・ライブ情報を閲覧できないため、記事を生成できません");
  }
  if (container) {
    if (dossier.articleTemplate && dossier.articleTemplate !== container.kind) {
      throw new WorkflowInputError("素材の種類と記事テンプレートが一致していません");
    }
    if (container.kind === "meetgreet") {
      const row = await getMeetGreet(user, container.id);
      assertContainer(user, dossier, row, chosenArticleId);
      return containerWorkflow(common, row, { kind: "meetgreet", meetGreet: row }, meetGreetTitle(row), row.date);
    }
    const row = await getLive(user, container.id);
    assertContainer(user, dossier, row, chosenArticleId);
    return containerWorkflow(common, row, { kind: "live", live: row }, row.name, livePeriodLabel(row));
  }
  if (chosenArticleId && !dossier.articles.some((a) => a.id === chosenArticleId)) {
    throw new WorkflowInputError("指定された記事はこのドシエに紐づいていません");
  }
  const articleId = chosenArticleId ?? (dossier.articles.length === 1 ? dossier.articles[0].id : null);
  const needsChoice = dossier.articles.length > 1 && !articleId;
  return {
    ...common, preparation: null, template: dossier.articleTemplate, articleId, needsChoice,
    article: dossier.articles.find((a) => a.id === articleId) ?? null,
    target: needsChoice || !dossier.articleTemplate ? null : { kind: "dossier", dossier, articleId },
  };
}

/** 器の詳細に共通する、紐づけ・準備状況の部分。 */
interface ContainerRow {
  dossierId: string;
  classification: string;
  dossier: { id: string; itemCount: number } | null;
  articleId: string | null;
  article: WorkflowArticle | null;
  reports: { keep: number } | null;
  sketchKey: string | null;
  needsSync: boolean;
}

function assertContainer(
  user: ActingUser, dossier: DossierForArticle, row: ContainerRow | null, chosenArticleId: string | null,
): asserts row is ContainerRow {
  if (!row || row.dossierId !== dossier.id || row.dossier?.id !== dossier.id) {
    throw new WorkflowInputError("関連する準備情報または素材を閲覧できません。画面を更新してください");
  }
  assertClearance(user.clearance, row.classification);
  if (chosenArticleId && chosenArticleId !== row.articleId) {
    throw new WorkflowInputError("この素材のミーグリ・ライブに紐づく記事を選んでください");
  }
  if (row.articleId && row.article?.id !== row.articleId) {
    throw new WorkflowInputError("紐づく記事を確認できません。準備画面で確認してください");
  }
}

function containerWorkflow(
  common: Pick<DossierArticleWorkflow, "dossier" | "editable">,
  row: ContainerRow,
  target: Exclude<ArticleTarget, { kind: "dossier" }>,
  title: string, period: string,
): DossierArticleWorkflow {
  return {
    ...common, target, template: target.kind, article: row.article, articleId: row.articleId, needsChoice: false,
    preparation: {
      kind: target.kind,
      href: `/${target.kind === "meetgreet" ? "meetgreets" : "lives"}/${target.kind === "meetgreet" ? target.meetGreet.id : target.live.id}`,
      title, period, materialCount: row.dossier?.itemCount ?? 0,
      keptReports: row.reports?.keep ?? 0, hasSketch: !!row.sketchKey, needsSync: row.needsSync,
    },
  };
}

/** 各 Server Action が同じ検査を通る。保存対象をクライアントの kind / containerId で決めない。 */
export async function requireDossierArticleWorkflow(user: ActingUser, dossierId: string, articleId: string | null) {
  const workflow = await getDossierArticleWorkflow(user, dossierId, articleId);
  if (!workflow) throw new WorkflowInputError("ドシエが見つかりません");
  if (!workflow.editable) throw new WorkflowInputError("このドシエの記事を作成・更新する権限がありません");
  if (!workflow.target) {
    throw new WorkflowInputError(workflow.needsChoice ? "追記する記事を選んでください" : "先にテンプレートを選んでください");
  }
  return { ...workflow, target: workflow.target };
}
