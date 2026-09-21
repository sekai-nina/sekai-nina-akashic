/**
 * 器を持たないドシエ (言葉・スナップ・おでかけ) から記事を組み立てる (#170)。
 *
 * ミーグリ (`meetgreet-article.ts`) の対になるもので、構造化メタは無く、ドシエの中身と
 * `Dossier.articleTemplate` だけで決まる。組み立てはテンプレートの `render` (純粋関数)。
 */

import type { ArticleTemplate, ArticleType, ClearanceLevel, DossierAccessMode, DossierKind } from "@prisma/client";
import { withSession } from "@/lib/db";
import { ARTICLE_TEMPLATE_LABELS, todayJst } from "@/lib/utils";
import { canEditDossier } from "@/lib/auth/dossier-permissions";
import { MAX_ARTICLE_CLEARANCE } from "@/lib/meetgreet/config";
import type { RenderedArticle } from "@/lib/article-workflow/render";
import {
  getTemplate,
  type AiDraft,
  type ArticleTemplateDef,
  type DossierRenderInput,
} from "@/lib/article-workflow/templates";
import { isQuoteBlogTitle } from "@/lib/article-workflow/templates/quote-blog";
import { TemplateInputError } from "@/lib/article-workflow/errors";
import { buildMaterialsText } from "@/lib/article-workflow/materials";
import {
  ARTICLE_AI_FEATURE,
  ArticleAiError,
  generateArticleDraft,
  isArticleAiConfigured,
  type AiUsage,
} from "@/lib/article-workflow/llm";
import { recordUsage } from "@/lib/costs/usage";
import { getArticleTitleIndex, listArticleTags } from "./articles";
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
  classification: ClearanceLevel;
  kind: DossierKind;
  /** 編集権限の判定に使う (`canEditDossier`)。保存のたびに読み直さない */
  ownerId: string;
  viewMode: DossierAccessMode;
  editMode: DossierAccessMode;
  /**
   * 器 (MeetGreet / Live) に使われているか。使われていればそちらの画面で記事にする。
   * **器が自分より上の機密だと見えない** (RLS) ので、器の有無だけでなく `articleTemplate` も見る
   * (`assertPlainDossier`)
   */
  container: { kind: "meetgreet" | "live"; id: string } | null;
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
        ownerId: true,
        viewMode: true,
        editMode: true,
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
  return {
    ...rest,
    container: meetGreet
      ? { kind: "meetgreet", id: meetGreet.id }
      : live
        ? { kind: "live", id: live.id }
        : null,
  };
}

/** 器 (MeetGreet / Live) が組むテンプレートか (= `render` を持たない) */
export function isContainerTemplate(template: ArticleTemplate | null): boolean {
  return template !== null && getTemplate(template)?.render === null;
}

/**
 * 器 (MeetGreet / Live) に使われているドシエはそちらの画面で記事にする。
 * クリップのプールは記事にしない (#41: 全員共有のプール)。
 *
 * 器が自分より上の機密だと `container` は null に見える (RLS) ので、**`articleTemplate` も見る**。
 * 器は作成時にテンプレートを書く (`claimDossierTemplate`) ので、見えなくても型で分かる
 */
export function assertPlainDossier(dossier: DossierForArticle): void {
  if (dossier.kind === "clips") throw new WorkflowInputError("クリップのプールは記事にできません");
  const container = dossier.container?.kind ?? (isContainerTemplate(dossier.articleTemplate) ? dossier.articleTemplate : null);
  if (container === "meetgreet") {
    throw new WorkflowInputError("このドシエはミーグリの素材です。記事は /meetgreets から作ってください");
  }
  if (container === "live") {
    throw new WorkflowInputError("このドシエはライブの素材です。記事は /lives から作ってください");
  }
}

/** 実装済みで、素のドシエから組めるテンプレート。それ以外は入力エラー */
export function requireRenderableTemplate(template: ArticleTemplate): ArticleTemplateDef {
  const def = getTemplate(template);
  if (!def || !def.render) {
    throw new WorkflowInputError(`テンプレート「${ARTICLE_TEMPLATE_LABELS[template]}」はまだ使えません`);
  }
  return def;
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
  requireRenderableTemplate(template);
  if (dossier.articleTemplate === template) return;
  if (dossier.articleTemplate && dossier.articles.length > 0) {
    throw new WorkflowInputError(
      "既にこのドシエから記事を作っているのでテンプレートは変えられません (別のドシエを作ってください)"
    );
  }
  if (!canEditDossier(user, dossier)) {
    throw new Error("Access denied: insufficient permission to edit this dossier");
  }
  // `updatedAt` を進めない (素の SQL)。frontmatter の `dossier.updated_at` と比べる「要反映」の判定を
  // 素材が変わっていないのに動かさないため。RLS は素の SQL にも効く (0 行なら権限が変わった)
  const written = await withSession(user, (tx) =>
    tx.$executeRaw`UPDATE "Dossier" SET "articleTemplate" = ${template}::"ArticleTemplate" WHERE "id" = ${dossier.id}`
  );
  if (written === 0) throw new WorkflowInputError("ドシエを更新できませんでした (権限が変わったか削除されています)");
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
  if (type === "quote" && dossier.articles.every((a) => isQuoteBlogTitle(a.title))) return "quote_blog";
  return null;
}

/** AI の状態 (画面に出す) */
export interface ArticleAiStatus {
  /** generated: 今回書いた / given: 画面から受け取った下書きを使った / unavailable: 使えなかった (骨組みだけ) */
  status: "generated" | "given" | "unavailable";
  model: string | null;
  /** unavailable の理由 (画面に出してよい文言) */
  reason: string | null;
  /** 素材に入れた出典の数 / 本文を切った出典の数 */
  included: number;
  truncated: number;
  usage: AiUsage | null;
  /** 今回の分の費用 (単価表に無ければ null) */
  costUsd: number | null;
}

export interface BuiltDossierArticle extends RenderedArticle {
  droppedByClearance: number;
  /** `needsAi` のテンプレートだけ。それ以外は null */
  ai: ArticleAiStatus | null;
  /** 保存に渡す下書き。AI が使えなかったときは null (骨組みで保存する) */
  aiDraft: AiDraft | null | undefined;
}

/**
 * ドシエの素材からテンプレートで記事を組み立てる。DB には書かない。
 *
 * 本文を AI が書くテンプレートは、`aiDraft` が渡されていればそれを差し込み (保存時)、
 * `undefined` なら Claude に書かせる (プレビュー時)、`null` なら骨組みだけにする。
 * AI が失敗したら**止めずに骨組みに落とす** (`ai.status = "unavailable"`)。Vercel Preview には
 * キーが無く、人が本文を書く道も残しておきたいため
 */
export async function buildDossierArticle(
  user: ActingUser,
  dossier: { id: string; title: string; classification: string },
  template: ArticleTemplateDef,
  options: { today?: string; aiDraft?: AiDraft | null } = {}
): Promise<BuiltDossierArticle> {
  if (!template.render) throw new TemplateInputError(`テンプレート ${template.key} は器が要ります`);

  // **記事の本文は公開リポジトリに載る。** アセット単位の絞り込み (PUBLISHABLE) だけでは
  // ドシエのサムネ・外部リンクが素通りするので、ドシエの機密も入口で見る
  if (!PUBLISHABLE.has(dossier.classification)) {
    throw new TemplateInputError(
      `ドシエが ${dossier.classification} なので記事にできません (公開リポジトリに載るため ${MAX_ARTICLE_CLEARANCE} 以下のみ)`
    );
  }

  const needsAi = template.needsAi && !!template.prompt;
  // AI のテンプレートは保存時 (下書きを持っている) も同じ読み方をする。画像しか無いブログの本文
  // アセットを出典の宛先にするので、プレビューと保存で出典が変わらないように
  const loaded = await withSession(user, (tx) => loadDossierForArticle(tx, dossier.id, { withTexts: needsAi }));
  if (!loaded) throw new TemplateInputError("ドシエが見つかりません (権限がないか削除されています)");
  // 上の判定は呼び出し側のスナップショット。読み直した行でもう一度見る (機密を上げられた直後)
  if (!PUBLISHABLE.has(loaded.classification)) {
    throw new TemplateInputError(`ドシエが ${loaded.classification} なので記事にできません`);
  }

  const materials = shapeDossierMaterials(loaded);
  const tiktoks = await resolveTiktoks(materials.tiktoks);
  const input: DossierRenderInput = {
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
  };

  if (!needsAi) {
    return { ...template.render(input), droppedByClearance: materials.droppedByClearance, ai: null, aiDraft: undefined };
  }

  const { draft, ai } = await draftForTemplate(user, template, input, options.aiDraft);
  return {
    ...template.render(input, draft),
    droppedByClearance: materials.droppedByClearance,
    ai,
    aiDraft: draft,
  };
}

/** 下書きを用意する: 渡されたものを使う / Claude に書かせる / 使えなければ null */
async function draftForTemplate(
  user: ActingUser,
  template: ArticleTemplateDef,
  input: DossierRenderInput,
  given: AiDraft | null | undefined
): Promise<{ draft: AiDraft | null; ai: ArticleAiStatus }> {
  const materials = buildMaterialsText(input);
  const base = { included: materials.included, truncated: materials.truncated };
  if (given !== undefined) {
    return {
      draft: given,
      ai: given
        ? { status: "given", model: null, reason: null, usage: null, costUsd: null, ...base }
        : { status: "unavailable", model: null, reason: "AI を使わずに骨組みだけで保存します", usage: null, costUsd: null, ...base },
    };
  }
  if (!isArticleAiConfigured()) {
    return {
      draft: null,
      ai: { status: "unavailable", model: null, reason: "ANTHROPIC_API_KEY が未設定です", usage: null, costUsd: null, ...base },
    };
  }
  if (materials.included === 0) {
    return {
      draft: null,
      ai: { status: "unavailable", model: null, reason: "本文のある素材 (ブログ / トーク) がドシエにありません", usage: null, costUsd: null, ...base },
    };
  }

  // 語彙は記事 (非保護テーブル) から。wikilink は既存タイトルにだけ張らせる
  const [titles, tags] = await Promise.all([getArticleTitleIndex(), listArticleTags()]);
  const prompt = template.prompt!(input, { existingTitles: [...titles.keys()], tagVocabulary: tags });

  try {
    const generated = await generateArticleDraft(prompt);
    // 費用は自己申告 (プロバイダの内訳はキー単位なので、機能名を付けるにはこちらで積む)
    let costUsd: number | null = null;
    try {
      const recorded = await recordUsage({
        provider: "anthropic",
        model: generated.model,
        feature: ARTICLE_AI_FEATURE,
        inputTokens: generated.usage.inputTokens,
        cachedInputTokens: generated.usage.cachedInputTokens,
        outputTokens: generated.usage.outputTokens,
        requests: 1,
      });
      costUsd = recorded.costUsd;
    } catch (e) {
      // 記録に失敗しても生成結果は返す (費用の行が 1 つ欠けるだけ)
      console.error("[dossier-article] recordUsage failed", e);
    }
    await logAudit({
      actorId: user.id,
      action: "dossier.article.ai",
      targetType: "Dossier",
      targetId: input.dossier.id,
      metadata: { template: template.key, model: generated.model, ...generated.usage, costUsd, ...base },
    });
    return {
      draft: generated.draft,
      ai: { status: "generated", model: generated.model, reason: null, usage: generated.usage, costUsd, ...base },
    };
  } catch (e) {
    if (e instanceof ArticleAiError) {
      return { draft: null, ai: { status: "unavailable", model: null, reason: e.message, usage: null, costUsd: null, ...base } };
    }
    throw e;
  }
}
