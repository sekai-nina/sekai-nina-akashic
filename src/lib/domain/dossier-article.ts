/**
 * 器を持たないドシエ (言葉・スナップ・おでかけ) から記事を組み立てる (#170)。
 *
 * ミーグリ (`meetgreet-article.ts`) の対になるもので、構造化メタは無く、ドシエの中身と
 * `Dossier.articleTemplate` だけで決まる。組み立てはテンプレートの `render` (純粋関数)。
 */

import type { ArticleTemplate, ArticleType, DossierKind } from "@prisma/client";
import { withSession } from "@/lib/db";
import { todayJst } from "@/lib/utils";
import { canEditDossier } from "@/lib/auth/dossier-permissions";
import { MAX_ARTICLE_CLEARANCE } from "@/lib/meetgreet/config";
import type { RenderedArticle } from "@/lib/article-workflow/render";
import { getTemplate, type ArticleTemplateDef } from "@/lib/article-workflow/templates";
import { TemplateInputError } from "@/lib/article-workflow/errors";
import { WorkflowInputError, type ActingUser } from "./article-workflow";
import { logAudit } from "./audit";
import {
  loadDossierForArticle,
  PUBLISHABLE,
  resolveTiktoks,
  shapeDossierMaterials,
} from "./dossier-materials";

/** 記事の器としてのドシエ (`getDossierForArticle` が返す) */
export interface DossierForArticle {
  id: string;
  title: string;
  classification: string;
  kind: DossierKind;
  /** 器 (MeetGreet / Live) に使われているか。使われていればそちらの画面で記事にする */
  container: "meetgreet" | "live" | null;
  articleTemplate: ArticleTemplate | null;
  /** 「足さない」と決めたもののキー (#134) */
  articleExclusions: unknown;
  /** このドシエを素材にした記事 (`Article.dossierId`)。追記先の候補 */
  articles: { id: string; shortId: string; title: string; type: ArticleType | null; draft: boolean }[];
}

/** ドシエを記事の器として読む。見えなければ null */
export async function getDossierForArticle(
  user: ActingUser,
  id: string
): Promise<DossierForArticle | null> {
  const row = await withSession(user, (tx) =>
    tx.dossier.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        classification: true,
        kind: true,
        articleTemplate: true,
        articleExclusions: true,
        meetGreet: { select: { id: true } },
        live: { select: { id: true } },
        // Article は非保護なので RLS で落ちない
        articles: {
          select: { id: true, shortId: true, title: true, type: true, draft: true },
          orderBy: { createdAt: "asc" },
        },
      },
    })
  );
  if (!row) return null;
  const { meetGreet, live, ...rest } = row;
  return { ...rest, container: meetGreet ? "meetgreet" : live ? "live" : null };
}

/**
 * 器 (MeetGreet / Live) に使われているドシエはそちらの画面で記事にする。
 * クリップのプールは記事にしない (#41: 全員共有のプール)
 */
export function assertPlainDossier(dossier: DossierForArticle): void {
  if (dossier.kind === "clips") throw new WorkflowInputError("クリップのプールは記事にできません");
  if (dossier.container === "meetgreet") {
    throw new WorkflowInputError("このドシエはミーグリの素材です。記事は /meetgreets から作ってください");
  }
  if (dossier.container === "live") {
    throw new WorkflowInputError("このドシエはライブの素材です。記事は /lives から作ってください");
  }
}

/**
 * テンプレートを決める。器のドシエには書かせない (器が決める)。
 * 既に別のテンプレートで記事を作っていたら、記事の型が変わるので付け替えさせない
 */
export async function setDossierTemplate(
  user: ActingUser,
  dossier: DossierForArticle,
  template: ArticleTemplate
): Promise<void> {
  assertPlainDossier(dossier);
  const def = getTemplate(template);
  if (!def || !def.render) throw new WorkflowInputError(`テンプレート ${template} はまだ使えません`);
  if (dossier.articleTemplate && dossier.articleTemplate !== template && dossier.articles.length > 0) {
    throw new WorkflowInputError(
      "既にこのドシエから記事を作っているのでテンプレートは変えられません (別のドシエを作ってください)"
    );
  }
  await withSession(user, async (tx) => {
    const access = await tx.dossier.findUnique({
      where: { id: dossier.id },
      select: { ownerId: true, classification: true, viewMode: true, editMode: true },
    });
    if (!access) throw new WorkflowInputError("ドシエが見つかりません (権限がないか削除されています)");
    if (!canEditDossier(user, access)) {
      throw new Error("Access denied: insufficient permission to edit this dossier");
    }
    await tx.dossier.update({ where: { id: dossier.id }, data: { articleTemplate: template } });
  });
  await logAudit({
    actorId: user.id,
    action: "dossier.template.set",
    targetType: "Dossier",
    targetId: dossier.id,
    metadata: { template, previous: dossier.articleTemplate },
  });
}

/**
 * 紐づく記事の型から既定のテンプレートを推す (#172 で outing / quote_situational を足す)。
 * 推せなければ null (画面で選ばせる)
 */
export function suggestTemplate(dossier: DossierForArticle): ArticleTemplate | null {
  const types = new Set(dossier.articles.map((a) => a.type));
  if (types.size !== 1) return null;
  const [type] = types;
  if (type === "quote" && dossier.articles.every((a) => a.title.startsWith("ブログ「"))) return "quote_blog";
  return null;
}

/** ドシエの素材からテンプレートで記事を組み立てる。DB には書かない */
export async function buildDossierArticle(
  user: ActingUser,
  dossier: { id: string; title: string; classification: string },
  template: ArticleTemplateDef,
  options: { today?: string } = {}
): Promise<RenderedArticle & { droppedByClearance: number }> {
  if (!template.render) throw new TemplateInputError(`テンプレート ${template.key} は器が要ります`);

  // **記事の本文は公開リポジトリに載る。** アセット単位の絞り込み (PUBLISHABLE) だけでは
  // ドシエのサムネ・外部リンクが素通りするので、ドシエの機密も入口で見る
  if (!PUBLISHABLE.has(dossier.classification)) {
    throw new TemplateInputError(
      `ドシエが ${dossier.classification} なので記事にできません (公開リポジトリに載るため ${MAX_ARTICLE_CLEARANCE} 以下のみ)`
    );
  }

  const loaded = await withSession(user, (tx) => loadDossierForArticle(tx, dossier.id));
  if (!loaded) throw new TemplateInputError("ドシエが見つかりません (権限がないか削除されています)");

  const materials = shapeDossierMaterials(loaded);
  const tiktoks = await resolveTiktoks(materials.tiktoks);

  return {
    ...template.render({
      dossier: {
        id: loaded.id,
        title: loaded.title,
        updatedAt: loaded.updatedAt.toISOString(),
        itemCount: loaded.itemCount,
      },
      assets: materials.assets,
      reports: materials.reports,
      tiktoks,
      thumbnailUrl: materials.dossierThumb,
      today: options.today ?? todayJst(),
    }),
    droppedByClearance: materials.droppedByClearance,
  };
}
