/**
 * ドシエから記事を組み立てて保存する、テンプレート共通の層 (#169 / #170)。
 *
 * ミーグリ記事の保存 (`meetgreet-article-save.ts`、#109) を「器 + テンプレート」で動く形にしたもの。
 * 器は 3 種類:
 *
 * - **MeetGreet** (`ArticleTarget.kind = "meetgreet"`): 開催日などの構造化メタを持つ行。組み立ては
 *   `buildMeetGreetArticle`、記事の紐づけは `MeetGreet.articleId`、除外は `MeetGreet.articleExclusions`
 * - **Dossier** (`kind = "dossier"`): 器を持たないテンプレート (言葉・スナップ・おでかけ)。
 *   `Dossier.articleTemplate` が型を決め、組み立てはテンプレートの `render`、記事の紐づけは
 *   `Article.dossierId`、除外は `Dossier.articleExclusions`
 *
 * - **Live** (`kind = "live"`): MeetGreet と同型 (公演・曲を持つ)。組み立ては `buildLiveArticle`
 *
 * 組み立て (`build`) と追記の計算 (`lib/meetgreet/append.ts`) は純粋関数で、ここが DB への反映を
 * 受け持つ。記事まわりの既存の仕組み (`createArticle` / `updateArticle` / `applyArticleSource`)
 * をそのまま使う。
 *
 * **出典は `applyArticleSource` を順に呼ぶ。** この関数が `sourceNo` を max+1 で採るので、
 * 組み立てた順に呼べば本文の `^[n]` と一致する。直接 INSERT しないことで、
 * classification のガード (公開してよい機密レベルの上限) も効いたままになる。
 */

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma, withClearance, withSession, type TransactionClient } from "@/lib/db";
import { EXCLUSION_KIND_LABELS, todayJst } from "@/lib/utils";
import { canEditDossier } from "@/lib/auth/dossier-permissions";
import { parseFrontmatterDate, splitLocations } from "@/lib/articles/frontmatter";
import { jsonStringArray, MAX_ARTICLE_CLEARANCE } from "@/lib/meetgreet/config";
import { exclusionKey, planAppend, isPureAppend, type AppendLayout } from "@/lib/meetgreet/append";
import {
  checkMerge,
  finalizeMerge,
  groupFreshBySource,
  isFreshClip,
  mergePrompt,
  renumberMaterials,
  unwrapFence,
  type FreshMaterial,
} from "@/lib/article-workflow/merge";
import { buildMaterialsText } from "@/lib/article-workflow/materials";
import { normalizeAiBody } from "@/lib/article-workflow/templates/shared";
import { expandPlaceCards, placesText } from "@/lib/article-workflow/templates/outing";
import { ArticleAiError } from "@/lib/article-workflow/llm";
import type { ArticleMode, ArticlePreview } from "@/lib/meetgreet/types";
import type { ArticleAssetInput, RenderedArticle, RenderedSource } from "@/lib/article-workflow/render";
import {
  LIVE_TEMPLATE,
  MEETGREET_TEMPLATE,
  type AiDraft,
  type ArticleAiStatus,
  type ArticleTemplateDef,
} from "@/lib/article-workflow/templates";
import { TemplateInputError } from "@/lib/article-workflow/errors";
import {
  addAssetToArticle,
  applyArticleSource,
  createArticle,
  updateArticle,
  type ArticleActor,
} from "./articles";
import { WorkflowInputError, type ActingUser } from "./article-workflow";
import { buildMeetGreetArticle } from "./meetgreet-article";
import { buildLiveArticle, type LiveForArticle } from "./live-article";
import { LiveInputError } from "./lives";
import {
  assertPlainDossier,
  buildDossierArticle,
  generateMergeDraft,
  loadRenderInput,
  mergeSystemPrompt,
  requireRenderableTemplate,
  type DossierForArticle,
} from "./dossier-article";
import { MeetGreetInputError } from "./meetgreets";
import { logAudit } from "./audit";

/** プレビューした内容と保存する内容が同じかを見るための指紋 */
export function bodyDigest(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/**
 * 新規作成の指紋は**本文 + 出典**で取る。本文を AI が書くテンプレートは本文が画面から来る
 * (素材と独立) ので、本文だけだとプレビューのあとで素材が増減して脚注の宛先がずれても
 * 気づけない。機械で組むテンプレートでも出典を含めるほうが厳しいだけで害は無い
 */
function createDigest(rendered: { body: string; sources: RenderedSource[] }): string {
  const sources = rendered.sources.map((s) => `${s.sourceNo}:${s.assetId ?? s.url ?? ""}`).join("\n");
  return bodyDigest(`${rendered.body}\n--sources--\n${sources}`);
}

/**
 * 追記の指紋も**本文 + 足す出典**で取る。出典だけを足すテンプレート (#267) は本文が変わらないので、
 * 本文だけだとプレビューのあとで素材が増えても気づけず、見ていない出典を反映してしまう
 */
function appendDigest(plan: { body: string; newSources: RenderedSource[] }): string {
  if (plan.newSources.length === 0) return bodyDigest(plan.body);
  const sources = plan.newSources.map((s) => `${s.sourceNo}:${s.assetId ?? s.url ?? ""}`).join("\n");
  return bodyDigest(`${plan.body}\n--sources--\n${sources}`);
}

/**
 * 組み込みの指紋。載っている出典に足したメモ・抜粋のクリップも含める
 * (案を作ったあとで入ったクリップを、見ないまま取り込み済みにしないように)
 */
function mergeDigest(plan: { body: string; newSources: RenderedSource[] }, fresh: FreshMaterial[]): string {
  if (fresh.length === 0) return appendDigest(plan);
  // メモ・抜粋の中身も入れる (案を作ったあとで書き換えたメモを、見ないまま取り込み済みにしない)
  const parts = fresh.map((f) => [...f.itemIds, ...f.notes, ...f.excerpts].join("\u0000")).sort();
  return bodyDigest(`${appendDigest(plan)}\n--fresh--\n${parts.join("\n")}`);
}

/**
 * 企画の素材をここまで取り込んだ、を記事に書く。push の出力には載らないので dirty は立てない
 * (`updatedAt` も動かさないよう生の UPDATE。楽観ロックの照合に使っているので)
 */
async function markMaterialsSynced(articleId: string, at: Date): Promise<void> {
  // 列は timestamp (タイムゾーン無し) で、Prisma は UTC で読み書きする。セッションのタイムゾーンに依らず UTC で入れる
  await prisma.$executeRaw`UPDATE "Article" SET "materialsSyncedAt" = (${at}::timestamptz AT TIME ZONE 'UTC') WHERE "id" = ${articleId}`;
}

export interface MeetGreetForArticle {
  id: string;
  date: string;
  format: "online" | "real";
  venue: string | null;
  label: string;
  single: string;
  dossierId: string;
  repoCollectionId: string | null;
  sketchKey: string | null;
  articleId: string | null;
  classification: string;
  /** 「足さない」と決めたもののキー (#134) */
  articleExclusions: unknown;
}

/** 記事の器。どこから素材を取り、どこに記事を紐づけるか */
export type ArticleTarget =
  | { kind: "meetgreet"; meetGreet: MeetGreetForArticle }
  | { kind: "live"; live: LiveForArticle }
  | {
      kind: "dossier";
      dossier: DossierForArticle;
      /**
       * 追記する記事。ドシエは記事を複数持てる (`Article.dossierId` は 1:N) ので、
       * 2 本以上あるときは呼び出し側が選ぶ。1 本ならそれ、0 本なら新規作成
       */
      articleId?: string | null;
    };

/** ドシエが器のときの入力エラー (REST は 400) */
export class DossierArticleError extends WorkflowInputError {}

/** 組み立ての結果。AI の情報は本文を AI が書くテンプレートだけ入る (ミーグリは付けない) */
type BuiltArticle = RenderedArticle & {
  droppedByClearance: number;
  ai?: ArticleAiStatus | null;
  aiDraft?: AiDraft | null;
};

/**
 * 器ごとの違いをここに閉じ込める。preview / save 本体は器を知らない
 */
interface ResolvedTarget {
  template: ArticleTemplateDef;
  layout: AppendLayout;
  /** 追記する既存記事。無ければ新規作成 */
  articleId: string | null;
  /** 器のスナップショットにある除外キー */
  storedExclusions: string[];
  /**
   * 組み立てる。`aiDraft` は本文を AI が書くテンプレートだけ意味を持つ
   * (undefined = 生成する / AiDraft = それを使う / null = 骨組みだけ)
   */
  build: (aiDraft?: AiDraft | null) => Promise<BuiltArticle>;
  /** 除外キーを**読み直してから**足す (1 トランザクション。保存中に別タブで戻されたものを古い値で書き戻さない) */
  addExclusions: (keys: readonly string[]) => Promise<string[]>;
  /** 除外キーを取り消す。戻した数を返す */
  removeExclusions: (keys: readonly string[]) => Promise<number>;
  /** 作った記事を器に紐づける */
  link: (articleId: string) => Promise<void>;
  /** 保存してよいか (ドシエは編集権限が要る)。だめなら投げる */
  assertCanSave: () => void;
  /** 入力エラーの型 (器ごとの REST が catch する) */
  inputError: (message: string) => Error;
  audit: { targetType: string; targetId: string; prefix: string };
}

function resolveTarget(user: ActingUser, target: ArticleTarget): ResolvedTarget {
  if (target.kind === "meetgreet") return resolveMeetGreet(user, target.meetGreet);
  if (target.kind === "live") return resolveLive(user, target.live);
  return resolveDossier(user, target.dossier, target.articleId ?? null);
}

/**
 * 器 (MeetGreet / Live) の共通部分。どちらも `articleId` / `dossierId` / `articleExclusions` /
 * `classification` を同じ形で持ち、所有者は持たない (見えていれば書ける)。
 * 違うのは行の読み書き (`store`) と組み立てだけ
 */
interface ContainerStore {
  readExclusions: (tx: TransactionClient) => Promise<unknown>;
  writeExclusions: (tx: TransactionClient, next: string[]) => Promise<unknown>;
  linkArticle: (tx: TransactionClient, articleId: string) => Promise<unknown>;
}

function resolveContainer(
  user: ActingUser,
  input: {
    template: ArticleTemplateDef;
    row: { id: string; articleId: string | null; dossierId: string; articleExclusions: unknown };
    store: ContainerStore;
    build: () => Promise<BuiltArticle>;
    inputError: (message: string) => Error;
    audit: { targetType: string; prefix: string };
  }
): ResolvedTarget {
  const { template, row, store } = input;
  const stored = jsonStringArray(row.articleExclusions);
  return {
    template,
    layout: template.appendLayout,
    articleId: row.articleId,
    storedExclusions: stored,
    build: input.build,
    // 読み直しと書き込みを 1 トランザクションに収める (別タブで戻されたものを古い値で書き戻さない)
    addExclusions: async (keys) => {
      if (keys.length === 0) return [];
      return withClearance(user.clearance, async (tx) => {
        const next = [...new Set([...jsonStringArray(await store.readExclusions(tx)), ...keys])];
        await store.writeExclusions(tx, next);
        return next;
      });
    },
    removeExclusions: async (keys) => {
      const next = stored.filter((k) => !keys.includes(k));
      if (next.length === stored.length) return 0;
      await withClearance(user.clearance, (tx) => store.writeExclusions(tx, next));
      return stored.length - next.length;
    },
    link: async (articleId) => {
      // **先に紐づける。** 出典や本文の書き込みで落ちたとき、記事だけできて器に繋がっていないと、
      // 次の実行が path_exists で止まり手当てのしようがなくなる
      await withClearance(user.clearance, async (tx) => {
        await store.linkArticle(tx, articleId);
        // 記事の素材ドシエ (#41) は器のドシエ。updatedAt を進めないよう素の SQL で書く
        await tx.$executeRaw`UPDATE "Article" SET "dossierId" = ${row.dossierId} WHERE "id" = ${articleId} AND "dossierId" IS NULL`;
      });
    },
    // 器は所有者を持たない (classification だけ)。見えていれば書ける
    assertCanSave: () => {},
    inputError: input.inputError,
    audit: { targetType: input.audit.targetType, targetId: row.id, prefix: input.audit.prefix },
  };
}

function resolveLive(user: ActingUser, live: LiveForArticle): ResolvedTarget {
  return resolveContainer(user, {
    template: LIVE_TEMPLATE,
    row: live,
    store: {
      readExclusions: (tx) =>
        tx.live.findUnique({ where: { id: live.id }, select: { articleExclusions: true } }).then((r) => r?.articleExclusions),
      writeExclusions: (tx, next) =>
        tx.live.update({ where: { id: live.id }, data: { articleExclusions: next as unknown as Prisma.InputJsonValue } }),
      linkArticle: (tx, articleId) => tx.live.update({ where: { id: live.id }, data: { articleId } }),
    },
    build: () => buildLiveArticle(user, live),
    inputError: (message) => new LiveInputError(message),
    audit: { targetType: "Live", prefix: "live.article" },
  });
}

function resolveMeetGreet(user: ActingUser, meetGreet: MeetGreetForArticle): ResolvedTarget {
  return resolveContainer(user, {
    template: MEETGREET_TEMPLATE,
    row: meetGreet,
    store: {
      readExclusions: (tx) =>
        tx.meetGreet
          .findUnique({ where: { id: meetGreet.id }, select: { articleExclusions: true } })
          .then((r) => r?.articleExclusions),
      writeExclusions: (tx, next) =>
        tx.meetGreet.update({
          where: { id: meetGreet.id },
          data: { articleExclusions: next as unknown as Prisma.InputJsonValue },
        }),
      linkArticle: (tx, articleId) => tx.meetGreet.update({ where: { id: meetGreet.id }, data: { articleId } }),
    },
    build: () => buildMeetGreetArticle(user, meetGreet),
    inputError: (message) => new MeetGreetInputError(message),
    audit: { targetType: "MeetGreet", prefix: "meetgreet.article" },
  });
}

function resolveDossier(
  user: ActingUser,
  dossier: DossierForArticle,
  chosenArticleId: string | null
): ResolvedTarget {
  assertPlainDossier(dossier);
  if (!dossier.articleTemplate) {
    throw new DossierArticleError("記事テンプレートが未設定です。先にテンプレートを選んでください");
  }
  const template = requireRenderableTemplate(dossier.articleTemplate);

  // 追記先。ドシエは記事を複数持てるので、2 本以上なら選んでもらう
  let articleId: string | null = null;
  if (chosenArticleId) {
    if (!dossier.articles.some((a) => a.id === chosenArticleId)) {
      throw new DossierArticleError("指定された記事はこの企画に紐づいていません");
    }
    articleId = chosenArticleId;
  } else if (dossier.articles.length === 1) {
    articleId = dossier.articles[0].id;
  } else if (dossier.articles.length > 1) {
    throw new DossierArticleError(
      `この企画には記事が ${dossier.articles.length} 本紐づいています。追記する記事を選んでください`
    );
  }

  // 編集権限は読み込んだ行で判定する (保存のたびに読み直さない)。RLS は書き込みにも効くので、
  // 権限が変わっていれば素の SQL が 0 行になって下で止まる
  const assertCanSave = () => {
    if (!canEditDossier(user, dossier)) {
      throw new Error("Access denied: insufficient permission to edit this dossier");
    }
  };
  /**
   * 除外キーの書き込み。**`updatedAt` を進めない** (素の SQL)。保存の直後に書くので、
   * `tx.dossier.update` だと frontmatter に書いたばかりの `dossier.updated_at` が即座に古くなり、
   * 何も変わらない push が積まれ続ける
   */
  const writeExclusions = async (tx: Parameters<Parameters<typeof withSession>[1]>[0], next: string[]) => {
    const written =
      await tx.$executeRaw`UPDATE "Dossier" SET "articleExclusions" = ${JSON.stringify(next)}::jsonb WHERE "id" = ${dossier.id}`;
    if (written === 0) throw new DossierArticleError("企画を更新できませんでした (権限が変わったか削除されています)");
  };
  return {
    template,
    layout: template.appendLayout,
    articleId,
    storedExclusions: jsonStringArray(dossier.articleExclusions),
    build: (aiDraft) => buildDossierArticle(user, dossier, template, { aiDraft }),
    // 読み直しと書き込みを 1 トランザクションに収める (別タブで戻されたものを古い値で書き戻さない)
    addExclusions: async (keys) => {
      if (keys.length === 0) return [];
      return withSession(user, async (tx) => {
        const row = await tx.dossier.findUnique({ where: { id: dossier.id }, select: { articleExclusions: true } });
        const next = [...new Set([...jsonStringArray(row?.articleExclusions), ...keys])];
        await writeExclusions(tx, next);
        return next;
      });
    },
    removeExclusions: async (keys) => {
      assertCanSave();
      const stored = jsonStringArray(dossier.articleExclusions);
      const next = stored.filter((k) => !keys.includes(k));
      if (next.length === stored.length) return 0;
      await withSession(user, (tx) => writeExclusions(tx, next));
      return stored.length - next.length;
    },
    link: async (articleId) => {
      // Article は非保護テーブル。updatedAt を進めないよう素の SQL で書く (`ensureArticleDossier` と同じ)
      await prisma.$executeRaw`UPDATE "Article" SET "dossierId" = ${dossier.id} WHERE "id" = ${articleId} AND "dossierId" IS NULL`;
    },
    assertCanSave,
    inputError: (message) => new DossierArticleError(message),
    audit: { targetType: "Dossier", targetId: dossier.id, prefix: "dossier.article" },
  };
}

/** テンプレートの入力エラーを器のエラーに包む (REST が 400 にできる型に揃える) */
async function buildOrThrow(resolved: ResolvedTarget, aiDraft?: AiDraft | null) {
  try {
    return await resolved.build(aiDraft);
  } catch (e) {
    if (e instanceof TemplateInputError) throw resolved.inputError(e.message);
    throw e;
  }
}

/**
 * 生成結果を見せる (DB には書かない)。
 * 既存記事があれば追記の差分、無ければ新規作成の本文を返す。
 */
export async function previewArticle(
  user: ActingUser,
  target: ArticleTarget,
  /** まだ保存していない「外すつもり」のキー。本文にだけ効かせて DB には書かない */
  extraExclude: readonly string[] = []
): Promise<ArticlePreview> {
  const resolved = resolveTarget(user, target);
  // 本文を AI に書かせる新規作成は 1 回ごとに費用がかかる。見えるだけの人には押させない
  // (保存できないのに生成できる、を塞ぐ)
  if (resolved.template.needsAi && !resolved.articleId) resolved.assertCanSave();
  // 追記では本文を AI に書かせない (地の文は人のもの)。新規作成のときだけ生成する
  const rendered = await buildOrThrow(resolved, resolved.articleId ? null : undefined);

  if (!resolved.articleId) {
    return {
      mode: "create",
      title: rendered.title,
      body: rendered.body,
      digest: createDigest(rendered),
      addedLines: [],
      newSources: rendered.sources,
      droppedByClearance: rendered.droppedByClearance,
      additions: [],
      excluded: [],
      empty: false,
      shortId: null,
      ai: rendered.ai ?? null,
      aiDraft: rendered.aiDraft ?? null,
    };
  }

  const article = await prisma.article.findUnique({
    where: { id: resolved.articleId },
    select: { shortId: true, body: true },
  });
  if (!article) throw resolved.inputError("紐づいている記事が見つかりません");
  const existingSources = await loadArticleSources(user, resolved.articleId);

  const stored = resolved.storedExclusions;
  const planArgs = {
    existingBody: article.body,
    parts: rendered.parts,
    sources: rendered.sources,
    existingSources,
    layout: resolved.layout,
  };
  const base = planOrThrow(resolved, { ...planArgs, excluded: stored });
  const plan =
    extraExclude.length > 0
      ? planOrThrow(resolved, { ...planArgs, excluded: [...stored, ...extraExclude] })
      : base;
  return {
    mode: "append",
    title: rendered.title,
    body: plan.body,
    // **指紋は保存時に照合するものと揃える。** 保存側は「保存済みの除外だけを当てた本文」で
    // 照合するので (= 外すつもりを渡せば照合をすり抜けられる、を塞ぐため)、
    // 重ねて見せているときも指紋は base のものを返す
    digest: appendDigest(base),
    addedLines: plan.changedLines,
    newSources: plan.newSources,
    droppedByClearance: rendered.droppedByClearance,
    // 一覧は外すつもりのものも含めて出す (チェックを戻せるように)
    additions: base.additions,
    excluded: describeExclusions(stored, planArgs),
    empty: plan.empty,
    shortId: article.shortId,
    ai: null,
    aiDraft: null,
  };
}

/** 追記の計画。区間のマーカーが壊れている等のテンプレートの入力エラーは器のエラーに包む (REST は 400) */
function planOrThrow(resolved: ResolvedTarget, args: Parameters<typeof planAppend>[0]) {
  try {
    return planAppend(args);
  } catch (e) {
    if (e instanceof TemplateInputError) throw resolved.inputError(e.message);
    throw e;
  }
}

/**
 * 外しているものに名前をつける (戻す判断ができるように)。
 * 除外を当てずに組み直すと、外した当人が `additions` に現れるのでラベルが取れる。
 * ドシエから消えたものは候補に出てこないので、キーをそのまま見せる
 * (見えないまま残ると、同じものを足し直したいときに理由の分からない不在になる)。
 */
function describeExclusions(
  stored: readonly string[],
  planArgs: Omit<Parameters<typeof planAppend>[0], "excluded">
): { key: string; label: string }[] {
  if (stored.length === 0) return [];
  const labels = new Map(planAppend(planArgs).additions.map((a) => [a.key, a.label]));
  return stored.map((key) => ({ key, label: labels.get(key) ?? staleLabel(key) }));
}

/**
 * 素材から消えて名前が引けなくなったキーの表示。
 * 生のキーだけだと何だったか分からず、戻す判断ができない
 */
function staleLabel(key: string): string {
  const kind = key.split(":")[0];
  const name = (EXCLUSION_KIND_LABELS as Record<string, string>)[kind] ?? EXCLUSION_KIND_LABELS.asset;
  return `${name}（この素材にはもうありません: ${key}）`;
}

/** 「今後足さない」を取り消す。次のプレビューからまた候補に出る (#134) */
export async function restoreExclusions(
  user: ActingUser,
  target: ArticleTarget,
  keys: readonly string[]
): Promise<number> {
  const resolved = resolveTarget(user, target);
  const restored = await resolved.removeExclusions(keys);
  if (restored === 0) return 0;
  await logAudit({
    actorId: user.id,
    action: `${resolved.audit.prefix}.restore`,
    targetType: resolved.audit.targetType,
    targetId: resolved.audit.targetId,
    metadata: { restored, keys: [...keys] },
  });
  return restored;
}

export type SaveArticleResult =
  | {
      ok: true;
      mode: ArticleMode;
      shortId: string;
      added: number;
      sources: number;
      /** 反映できなかった出典 (本文の ^[n] が宛先を失っている可能性がある) */
      failed: string[];
    }
  | { ok: false; error: string };

/**
 * 既存の出典を読む。
 * **`ArticleSource` は保護テーブル**なので、`prisma.article` の入れ子で引くと
 * 無言で空配列になる (= 既存の脚注番号を見落として 1 から振り直してしまう)。
 */
async function loadArticleSources(user: ActingUser, articleId: string) {
  return withClearance(user.clearance, (tx) =>
    tx.articleSource.findMany({
      where: { articleId },
      select: { id: true, status: true, sourceNo: true, assetId: true, url: true },
    })
  );
}

/**
 * 出典を順に作って反映する。
 *
 * **必ず本文を書く前に呼ぶこと。** `nextSourceNo` は既存行の番号だけでなく
 * **本文に書かれている `^[n]` の最大値**も見て +1 する (`src/lib/articles/apply.ts`)。
 * 先に本文を書くと、本文が `^[1..N]` を含むせいで行には `N+1..2N` が振られ、
 * **生成した記事の脚注が全部リンク切れになる**。
 *
 * `updatedAt` は apply のたびに進むので、返り値を次の呼び出しに渡して楽観ロックを繋ぐ
 * (途中で他の編集が入ったら conflict になる)。
 */
async function applySources(
  shortId: string,
  articleId: string,
  sources: RenderedSource[],
  user: ActingUser,
  actor: ArticleActor,
  expectedUpdatedAt: Date
): Promise<{ applied: number; failed: string[]; updatedAt: Date }> {
  let applied = 0;
  let stamp = expectedUpdatedAt;
  const failed: string[] = [];
  for (const s of sources) {
    if (s.existingId) {
      // 記事に番号無しで載っている出典 (手書きの古い記事)。作り直さずに番号だけ振る
      const numbered = await withClearance(user.clearance, (tx) =>
        tx.articleSource.updateMany({
          where: { id: s.existingId, articleId, sourceNo: null },
          data: { sourceNo: s.sourceNo },
        })
      );
      if (numbered.count === 1) applied++;
      else failed.push(`${s.label} (番号を振れなかった)`);
      continue;
    }
    if (!s.assetId) {
      failed.push(`${s.label} (紐づけ先のアセットが無い)`);
      continue;
    }
    const created = await addAssetToArticle(
      { articleId, assetId: s.assetId, label: s.label, actor },
      user.clearance
    );
    const result = await applyArticleSource(
      {
        shortId,
        sourceId: created.id,
        expectedUpdatedAt: stamp,
        // 機械が集めた出典なので、公開に落とせる上限を API 経路と同じにする
        maxClassification: MAX_ARTICLE_CLEARANCE,
        actor,
      },
      user.clearance
    );
    if (result.ok) {
      applied++;
      stamp = result.updatedAt;
      // addAssetToArticle / applyArticleSource は url と date を持たない
      // (「捏造しない」方針)。組み立てで分かっているぶんはここで入れる。
      // 入れないと公開記事の脚注からブログへのリンクが消える
      if (s.url || s.date) {
        await withClearance(user.clearance, (tx) =>
          tx.articleSource.update({
            where: { id: created.id },
            data: {
              ...(s.url ? { url: s.url } : {}),
              ...(s.date ? { date: new Date(`${s.date}T00:00:00Z`) } : {}),
            },
          })
        );
      }
      // 予測した番号と実際に振られた番号がズレたら、本文の ^[n] が宛先を失う
      if (result.sourceNo !== s.sourceNo) {
        failed.push(`${s.label} (脚注番号が ${s.sourceNo} ではなく ${result.sourceNo} になった)`);
      }
    } else {
      failed.push(`${s.label} (${result.reason})`);
      if (result.reason === "conflict") break; // 以降は番号がずれるので続けない
    }
  }
  return { applied, failed, updatedAt: stamp };
}

/**
 * 比較用の文字列。`dossier.synced_at` を落とし、**キーの順を揃える**。
 *
 * DB から読んだ Json と組み立て直したオブジェクトはキーの順が違う
 * (保存時は `{id, updated_at, item_count, synced_at}`、読み戻すと別順) ので、
 * 素の `JSON.stringify` で比べると中身が同じでも必ず「違う」になる
 */
function comparableExtra(extra: Record<string, unknown>): string {
  const dossier = extra.dossier;
  const trimmed =
    dossier && typeof dossier === "object" && !Array.isArray(dossier)
      ? { ...extra, dossier: omit(dossier as Record<string, unknown>, "synced_at") }
      : extra;
  return stableJson(trimmed);
}

function omit(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _drop, ...rest } = obj;
  return rest;
}

/** キー順に依存しない JSON 文字列 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** 追記で書き直す frontmatterExtra: `dossier` + テンプレートが「機械のもの」と言うキー */
function refreshedExtra(template: ArticleTemplateDef, extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { dossier: extra.dossier };
  for (const key of template.refreshExtraOnAppend ?? []) if (key in extra) out[key] = extra[key];
  return out;
}

/**
 * frontmatter の dossier / meetgreet 等を入れ直す (push でそのまま復元される)。
 * `locations` の聖地 (`place_id`) の要素は入れない。記事↔聖地の正は ArticlePlace (#283) で、
 * 新規作成の保存が `linkArticlePlaces` で別に書く
 */
async function saveFrontmatterExtra(
  articleId: string,
  rawExtra: Record<string, unknown>
): Promise<void> {
  const { extra } = splitLocations(rawExtra);
  // 読んでから書くまでに編集画面の保存 (関連記事 `related` など、#319) が入ると、古い base で
  // 上書きして消してしまう。updatedAt を where に入れ、割り込まれたら読み直してやり直す
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await prisma.article.findUnique({
      where: { id: articleId },
      select: { frontmatterExtra: true, updatedAt: true },
    });
    if (!current) return;
    const base =
      current.frontmatterExtra && typeof current.frontmatterExtra === "object" && !Array.isArray(current.frontmatterExtra)
        ? (current.frontmatterExtra as Record<string, unknown>)
        : {};
    const next = { ...base, ...extra };
    // **実質同じなら書かない。** dirty は「DB の出力 ≠ GitHub」の意味なので、何も増えなかった
    // 保存のたびに立てると、`synced_at` の日付が動いただけの push が積まれる。
    // 「要反映」の判定に使うのは `item_count` と `updated_at` だけ (`loadNeedsSync`) なので、
    // `synced_at` の差は変化と見なさない (= 本当に取り込んだ日が残る)
    if (comparableExtra(next) === comparableExtra(base)) return;
    const { count } = await prisma.article.updateMany({
      where: { id: articleId, updatedAt: current.updatedAt },
      // 直接書くので dirty / editedAt も自分で立てる (次の push に載せるため)
      data: {
        frontmatterExtra: next as Prisma.InputJsonValue,
        dirty: true,
        editedAt: new Date(),
      },
    });
    if (count > 0) return;
  }
  throw new Error("frontmatter の保存が他の保存と衝突し続けました。時間をおいてやり直してください");
}

/**
 * 新規作成した記事に聖地を紐づける (ArticlePlace、訪問順)。非公開の聖地も付ける (#283)。
 * 見えない聖地は RLS で数が合わなくなるので付けずに飛ばす (読んだときと同じ操作者なので通常は起きない)
 */
async function linkArticlePlaces(articleId: string, placeIds: string[], clearance: string): Promise<void> {
  if (placeIds.length === 0) return;
  await withClearance(clearance, async (tx) => {
    const visible = new Set(
      (await tx.place.findMany({ where: { id: { in: placeIds } }, select: { id: true } })).map((p) => p.id)
    );
    const rows = placeIds
      .filter((id) => visible.has(id))
      .map((placeId, sortOrder) => ({ articleId, placeId, sortOrder }));
    if (rows.length) await tx.articlePlace.createMany({ data: rows, skipDuplicates: true });
  });
}

/** 生成結果を保存する。新規なら作成、既存なら追記 */
export async function saveArticle(
  user: ActingUser,
  target: ArticleTarget,
  /** 画面が見せたプレビューの指紋。渡すと、組み立て直した結果が変わっていたら中止する */
  expectedDigest?: string,
  /** 今回「足さない」と決めたもののキー。除外リストに追加してから組み立て直す (#134) */
  exclude: readonly string[] = [],
  /**
   * プレビューが返した AI の下書き (#171)。本文を AI が書くテンプレートの新規作成では
   * **これを差し込む** (保存で生成し直すと別の文になり指紋が合わない)。null は骨組みだけ
   */
  aiDraft?: AiDraft | null
): Promise<SaveArticleResult> {
  const actor: ArticleActor = { id: user.id };
  // 素材を読む前の時刻。これより後に入ったクリップは、記事を作ったあとの新しい素材になる
  const startedAt = new Date();
  const resolved = resolveTarget(user, target);
  resolved.assertCanSave();
  // 保存で AI を呼ばない: 新規作成は画面から受け取った下書き (無ければ骨組み)、追記は本文を触らない
  const rendered = await buildOrThrow(resolved, resolved.template.needsAi ? (aiDraft ?? null) : undefined);

  const mismatch = (digest: string) => expectedDigest !== undefined && digest !== expectedDigest;

  // --- 新規作成 ---
  if (!resolved.articleId) {
    // **黙って無視しない。** 新規作成はフル生成で、外す口が無い (追記の差分ではないため)。
    // 無視すると「外したつもりのものが本文に入ったまま公開リポジトリに向かう」
    if (exclude.length > 0) {
      return { ok: false, error: "記事がまだ無いので外すものを指定できません (先に記事を作ってください)" };
    }
    if (mismatch(createDigest(rendered))) {
      // 本文を AI が書くテンプレートで下書きを渡し忘れると骨組みになって必ず食い違う。理由を言う
      if (resolved.template.needsAi && aiDraft === undefined) {
        return { ok: false, error: "プレビューが返した aiDraft を保存に渡してください (渡さないと骨組みだけになります)" };
      }
      return {
        ok: false,
        error: "内容が変わりました (素材が増減したか、TikTok の解決結果が変わりました)。もう一度差分を見てください",
      };
    }
    const today = todayJst();
    // AI が書いた本文は人が見るまで「AI 書きたて (未確認)」にする (#169 → #327)。push 画面で選べない。
    // サイトに出すかどうか (draft) とは分け、作る記事は下書きにしない (未 push の間が未公開)。
    // 機械で完成する型 (テンプレートが draft: false) は確認済みで作る
    const needsReview = rendered.draft || resolved.template.needsAi;
    const draft = false;
    const created = await createArticle(
      {
        title: rendered.title,
        type: resolved.template.articleType,
        tags: rendered.tags,
        // **本文は後で入れる。** 出典の採番が本文の ^[n] を見るので、先に本文を入れると
        // 番号が本文の最大値の続きから振られてリンク切れになる
        body: "",
        date: rendered.dates.date,
        publishedAt: today,
        articleUpdatedAt: today,
        draft,
      },
      actor,
      { needsReview }
    );
    if (!created.ok) {
      const message =
        created.reason === "path_exists"
          ? `「${rendered.title}」と同じ名前の記事が既にあります (${created.existingTitle})。その記事に紐づけてから追記するか、企画のタイトルを変えてください`
          : created.reason === "path_exists_upstream"
            ? `公開リポジトリに同じ名前のファイルがあります (${created.path})。先に取り込んでください`
            : created.reason === "invalid_path"
              ? created.error
              : Object.values(created.errors).join(" / ");
      return { ok: false, error: message };
    }

    const articleId = created.article.id;
    const shortId = created.article.shortId;

    // **先に紐づける。** 出典や本文の書き込みで落ちたとき、記事だけできて器に繋がっていないと、
    // 次の実行が path_exists で止まり手当てのしようがなくなる
    await resolved.link(articleId);

    // 1. 出典を反映して番号を確定させる (本文はまだ空なので 1, 2, … と振られる)
    const applied = await applySources(
      shortId,
      articleId,
      rendered.sources,
      user,
      actor,
      created.article.updatedAt
    );

    // 2. 確定した番号を前提に本文を入れる
    const written = await updateArticle(
      shortId,
      applied.updatedAt,
      {
        title: rendered.title,
        type: resolved.template.articleType,
        tags: rendered.tags,
        body: rendered.body,
        date: rendered.dates.date ? parseFrontmatterDate(rendered.dates.date) : null,
        dateDisplay: rendered.dates.dateDisplay,
        dateMode: rendered.dates.dateMode,
        publishedAt: parseFrontmatterDate(today),
        articleUpdatedAt: parseFrontmatterDate(today),
        draft,
        unlisted: false,
        ongoing: false,
      },
      actor
    );
    if (!written.ok) {
      return {
        ok: false,
        error: `記事は作りましたが本文を書けませんでした (${written.reason})。/articles/${shortId} を確認してください`,
      };
    }

    await saveFrontmatterExtra(articleId, rendered.frontmatterExtra);
    await markMaterialsSynced(articleId, startedAt);
    await linkArticlePlaces(
      articleId,
      rendered.placeIds ?? splitLocations(rendered.frontmatterExtra).places.map((p) => p.placeId),
      user.clearance
    );

    await logAudit({
      actorId: user.id,
      action: `${resolved.audit.prefix}.create`,
      targetType: resolved.audit.targetType,
      targetId: resolved.audit.targetId,
      metadata: {
        articleId,
        shortId,
        template: resolved.template.key,
        sources: applied.applied,
        failed: applied.failed.length,
        dropped: rendered.droppedByClearance,
        // 本文を AI が書いたか (given = プレビューの下書き / unavailable = 骨組み)
        ai: rendered.ai?.status ?? null,
      },
    });
    return {
      ok: true,
      mode: "create",
      shortId,
      added: 0,
      sources: applied.applied,
      failed: applied.failed,
    };
  }

  // --- 追記 ---
  const articleId = resolved.articleId;
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: {
      shortId: true,
      body: true,
      updatedAt: true,
      title: true,
      type: true,
      tags: true,
      date: true,
      dateDisplay: true,
      dateMode: true,
      publishedAt: true,
      articleUpdatedAt: true,
      draft: true,
      unlisted: true,
      ongoing: true,
    },
  });
  if (!article) return { ok: false, error: "紐づいている記事が見つかりません" };
  const existingSources = await loadArticleSources(user, articleId);

  const stored = resolved.storedExclusions;
  const planArgs = {
    existingBody: article.body,
    parts: rendered.parts,
    sources: rendered.sources,
    existingSources,
    layout: resolved.layout,
  };

  // **指紋は「見せたときと同じ条件」で照合する。** 除外を足すと本文が変わるので、
  // 除外を当てる前の結果と突き合わせる (除外を渡せば照合をすり抜けられる、を防ぐ)
  const shown = planOrThrow(resolved, { ...planArgs, excluded: stored });
  if (mismatch(appendDigest(shown))) {
    return {
      ok: false,
      error: "内容が変わりました (素材が増減したか、記事が他で編集されました)。もう一度差分を見てください",
    };
  }

  const plan =
    exclude.length > 0
      ? planOrThrow(resolved, { ...planArgs, excluded: [...new Set([...stored, ...exclude])] })
      : shown;
  if (plan.empty) {
    // 全部外したケース。本文は変えないが、外した事実は覚える
    if (exclude.length > 0) {
      await resolved.addExclusions(exclude);
      await logAudit({
        actorId: user.id,
        action: `${resolved.audit.prefix}.append`,
        targetType: resolved.audit.targetType,
        targetId: resolved.audit.targetId,
        metadata: { shortId: article.shortId, added: 0, sources: 0, failed: 0, excluded: exclude },
      });
    }
    // 本文が増えなくてもドシエは動いている (アイテム削除・抜粋の編集など)。
    // スナップショットを更新しないと「要反映」バッジが永久に消えない
    await saveFrontmatterExtra(articleId, refreshedExtra(resolved.template, rendered.frontmatterExtra));
    return { ok: true, mode: "append", shortId: article.shortId, added: 0, sources: 0, failed: [] };
  }

  // **既存行が 1 行でも消えていたら適用しない。** 手で入れた ![rep] や文面の調整を守る最後の砦。
  // 毎回作り直す区間 (ライブの公演の表) は差し替えたあとの本文 (`baseBody`) と比べる
  if (!isPureAppend(plan.baseBody, plan.body)) {
    return { ok: false, error: "既存の本文が変化するため中止しました (純粋な追記になりません)" };
  }

  // **出典が先。** 本文を先に書くと ^[n] の最大値の続きから番号が振られてリンク切れになる
  const applied = await applySources(
    article.shortId,
    articleId,
    plan.newSources,
    user,
    actor,
    article.updatedAt
  );

  const updated = await updateArticle(
    article.shortId,
    applied.updatedAt,
    {
      title: article.title,
      type: article.type,
      tags: Array.isArray(article.tags) ? (article.tags as string[]) : [],
      body: plan.body,
      date: article.date,
      dateDisplay: article.dateDisplay,
      dateMode: article.dateMode,
      publishedAt: article.publishedAt,
      // 本文を直したら更新日を今日にする (記事編集の慣習に合わせる)
      articleUpdatedAt: parseFrontmatterDate(todayJst()),
      draft: article.draft,
      unlisted: article.unlisted,
      ongoing: article.ongoing,
    },
    actor
  );
  if (!updated.ok) {
    return {
      ok: false,
      error: updated.reason === "conflict" ? "記事が他で更新されました。読み直してからやり直してください" : "記事が見つかりません",
    };
  }

  // ドシエのスナップショットを今回の状態に更新する (要反映の判定に使う)。
  // 機械が持つブロック (ライブの `live:`) も作り直す。それ以外のキーは新規作成時のまま
  await saveFrontmatterExtra(articleId, refreshedExtra(resolved.template, rendered.frontmatterExtra));

  // **除外を覚えるのは本文の保存に成功してから。** 先に書くと、衝突や純粋追記でない等で
  // 中止したときに「外した」だけが残り、戻す手段が無くなる
  await resolved.addExclusions(exclude);

  const added = plan.changedLines.length;
  await logAudit({
    actorId: user.id,
    action: `${resolved.audit.prefix}.append`,
    targetType: resolved.audit.targetType,
    targetId: resolved.audit.targetId,
    metadata: {
      shortId: article.shortId,
      added,
      sources: applied.applied,
      failed: applied.failed.length,
      excluded: exclude,
      ...plan.added,
    },
  });
  return {
    ok: true,
    mode: "append",
    shortId: article.shortId,
    added,
    sources: applied.applied,
    failed: applied.failed,
  };
}

// --- AI に既存の記事へ組み込ませる (#275) ---

/** 組み込みの案。画面はこれを見せ、人が `body` を直して `saveMerge` に渡す */
export interface MergeProposal {
  /** AI の案 (足す前の本文に、差し込み・`^[n]` の追加をしたもの) */
  body: string;
  /** 保存時に照合する指紋 (`previewArticle` の追記の指紋と同じ) */
  digest: string;
  /** AI が差し込んだ / `^[n]` を足した行 (`body` の 0 始まりの位置) */
  changedLines: number[];
  /**
   * AI に渡す前に機械で足した行の中身 (おでかけの関連メディアの画像・トークの行)。画面で別の色を付ける。
   * 位置ではなく中身で持つ (AI が前に行を差し込むと位置がずれる)
   */
  mechanicalLines: string[];
  /**
   * 今回足せる出典 (番号は記事での番号) と、その素材の中身 (画面の右側に出す)。
   * `existing` は記事に載っている出典に後から足したメモ・抜粋 (出典は増えない)
   */
  newSources: { sourceNo: number; label: string; material: string; existing?: boolean }[];
  /** AI を使わずに手で書く (`manual`) ときは null */
  ai: ArticleAiStatus | null;
  /** 新しいクリップが画像・動画だけで、機械で足した行だけの案 (AI は呼んでいない) */
  mechanicalOnly: boolean;
  /** 「今後足さない」にしているもの (戻せるように見せる) */
  excluded: { key: string; label: string }[];
}

export type MergeProposalResult =
  | { ok: true; proposal: MergeProposal }
  | { ok: false; error: string; excluded?: { key: string; label: string }[] };

/** 組み込みの下準備: 素材・追記の計画・既存の出典。案と保存で同じものを使う (指紋を揃える) */
async function prepareMerge(user: ActingUser, target: ArticleTarget) {
  if (target.kind !== "dossier") throw new DossierArticleError("AI の組み込みは企画が器の記事だけです");
  const resolved = resolveTarget(user, target);
  if (!resolved.template.needsAi) {
    throw resolved.inputError("このテンプレートは本文を機械で組むので、AI の組み込みは使いません (差分を追記してください)");
  }
  if (!resolved.articleId) throw resolved.inputError("まだ記事がありません。先に記事を作ってください");
  resolved.assertCanSave();
  const { input } = await loadRenderInput(user, target.dossier, resolved.template, { withTexts: true });
  let rendered;
  try {
    rendered = resolved.template.render!(input, null);
  } catch (e) {
    if (e instanceof TemplateInputError) throw resolved.inputError(e.message);
    throw e;
  }
  const article = await prisma.article.findUnique({
    where: { id: resolved.articleId },
    select: {
      shortId: true,
      body: true,
      updatedAt: true,
      title: true,
      type: true,
      tags: true,
      date: true,
      dateDisplay: true,
      dateMode: true,
      publishedAt: true,
      draft: true,
      unlisted: true,
      ongoing: true,
      materialsSyncedAt: true,
    },
  });
  if (!article) throw resolved.inputError("紐づいている記事が見つかりません");
  const existingSources = await loadArticleSources(user, resolved.articleId);
  const planArgs = {
    existingBody: article.body,
    parts: rendered.parts,
    sources: rendered.sources,
    existingSources,
    layout: resolved.layout,
  };
  const plan = planOrThrow(resolved, { ...planArgs, excluded: resolved.storedExclusions });
  const excluded = describeExclusions(resolved.storedExclusions, planArgs);
  const { fresh, stray: strayFresh } = await loadFreshClips(
    user,
    target.dossier.id,
    article.materialsSyncedAt,
    rendered,
    input.assets,
    plan
  );
  return {
    resolved,
    dossierId: target.dossier.id,
    input,
    rendered,
    article,
    articleId: resolved.articleId,
    existingSources,
    plan,
    excluded,
    fresh,
    strayFresh,
  };
}

/** 記事に載っている出典に、取り込んだあとで足されたメモ・抜粋 (記事での出典番号ごと) */
interface FreshSource extends FreshMaterial {
  /** 組み立ての番号 (`buildMaterialsText` に渡す) */
  renderedNo: number;
  /** 記事での番号 */
  sourceNo: number;
  label: string;
}

/**
 * 記事に素材を取り込んだあとで入れた、**出典として載っている素材への**メモ・抜粋つきのクリップ。
 * 出典が増えないので差分 (`planAppend`) には出ない。反映待ちの判定 (`dossier-sync-queue.ts` の
 * `judgeItem`) と同じ規則 (`isFreshClip`) で拾う
 */
async function loadFreshClips(
  user: ActingUser,
  dossierId: string,
  syncedAt: Date | null,
  rendered: RenderedArticle,
  assets: ArticleAssetInput[],
  plan: ReturnType<typeof planAppend>
): Promise<{ fresh: FreshSource[]; /** 出典の番号に結びつかなかったものがある */ stray: boolean }> {
  if (!syncedAt) return { fresh: [], stray: false };
  const items = await withSession(user, (tx) =>
    tx.dossierItem.findMany({
      where: { dossierId, kind: "asset_ref", createdAt: { gt: syncedAt } },
      select: { id: true, assetId: true, note: true, excerpt: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    })
  );
  const candidates = items.flatMap((i) => (i.assetId && isFreshClip(i, syncedAt) ? [{ ...i, assetId: i.assetId }] : []));
  if (candidates.length === 0) return { fresh: [], stray: false };
  // 新しい出典として足すもの (中身は丸ごと渡る) と、記事に載らない (除外した) ものは外す
  const adding = new Set(plan.newSources.map((s) => s.sourceNo));
  const out: FreshSource[] = [];
  for (const [renderedNo, m] of groupFreshBySource(assets, candidates)) {
    const sourceNo = plan.renumber.get(renderedNo);
    if (sourceNo === undefined || adding.has(sourceNo)) continue;
    const label = rendered.sources.find((s) => s.sourceNo === renderedNo)?.label ?? `出典 ${sourceNo}`;
    out.push({ ...m, renderedNo, sourceNo, label });
  }
  const mapped = new Set(out.flatMap((f) => f.itemIds));
  return { fresh: out.sort((a, b) => a.sourceNo - b.sourceNo), stray: candidates.some((c) => !mapped.has(c.id)) };
}


/**
 * AI に、新しい素材を既存の本文へ組み込んだ案を作らせる (DB の記事には書かない。費用はかかる)。
 * AI が既存の行を書き換えた案は使わずにエラーで返す。
 * `manual` は AI を呼ばず、足す前の本文をそのまま案にする (人が書く。AI が失敗したとき・自分で書きたいとき)
 */
export async function proposeMerge(
  user: ActingUser,
  target: ArticleTarget,
  options: { manual?: boolean } = {}
): Promise<MergeProposalResult> {
  const { resolved, dossierId, input, article, plan, excluded, fresh, strayFresh } = await prepareMerge(user, target);
  if (plan.newSources.length === 0 && fresh.length === 0) {
    // 反映待ちには出るのに出典の番号に結びつかないメモ (番号の無い古い出典など) だけがある。
    // 本文はそのままの案を返し、保存で取り込み済みにできるようにする (反映待ちに居座らせない)
    if (strayFresh) {
      return {
        ok: true,
        proposal: {
          body: plan.body,
          digest: mergeDigest(plan, fresh),
          changedLines: [],
          mechanicalLines: [],
          newSources: [],
          ai: null,
          mechanicalOnly: true,
          excluded,
        },
      };
    }
    return { ok: false, error: "記事に足せる新しい素材がありません", excluded };
  }
  const template = resolved.template as ArticleTemplateDef & { needsAi: true };
  // 画像・動画だけのクリップ (ブログ画像・画像のトーク) は、機械で関連メディアの行を足して終わり。
  // AI には渡さない (渡すとブログ全文から本文に余計な行を書き足す)。
  // 文章のアセット (ブログ本文・文章のトーク) を企画に入れた出典だけ、AI に本文へ組み込ませる
  // (画像に合わせて補ったブログ本文 `supplement` は数えない)
  const planLines = plan.body.split("\n");
  const mechanicalNos = new Set(
    plan.changedLines.flatMap((i) => [...(planLines[i] ?? "").matchAll(/\^\[(\d+)\]/g)].map((m) => Number(m[1])))
  );
  const textAssets = new Set(input.assets.filter((a) => a.kind === "text" && !a.supplement).map((a) => a.id));
  // 番号無しで記事に載っている出典 (`existingId`) は、行が参照するから番号を振るだけで本文には書かせない
  const writeSources = plan.newSources.filter(
    (s) => !s.existingId && (!mechanicalNos.has(s.sourceNo) || (s.assetId != null && textAssets.has(s.assetId)))
  );
  const newNos = new Set(writeSources.map((s) => s.sourceNo));
  // 中身を渡すのは新しい素材だけ (組み立ての番号で指定する)
  const focus = new Set([...plan.renumber].filter(([, to]) => newNos.has(to)).map(([from]) => from));
  // 載っている出典に足したメモ・抜粋は、本文抜きでそれだけを渡す
  const materials = buildMaterialsText(input, focus, new Map(fresh.map((f) => [f.renderedNo, f])));
  const markNos = new Set([...newNos, ...fresh.map((f) => f.sourceNo)]);
  const renumbered = renumberMaterials(materials.text, plan.renumber, markNos);
  const materialByNo = new Map(renumbered.sections.map((s) => [s.no, s.text]));
  const proposal = (body: string, changedLines: number[], ai: ArticleAiStatus | null): MergeProposal => ({
    body,
    digest: mergeDigest(plan, fresh),
    changedLines,
    mechanicalLines: plan.changedLines.map((i) => plan.body.split("\n")[i]).filter((l) => l && l.trim()),
    newSources: plan.newSources.map((s) => ({
      sourceNo: s.sourceNo,
      label: s.label,
      material:
        materialByNo.get(s.sourceNo) ??
        (newNos.has(s.sourceNo)
          ? ""
          : s.existingId
            ? `^[${s.sourceNo}] ${s.label}\n（記事にもう載っている出典。黄色の行から参照するので番号を振ります）`
            : `^[${s.sourceNo}] ${s.label}\n（画像・動画だけのクリップ。黄色の行として足します）`),
    })).concat(
      fresh.map((f) => ({ sourceNo: f.sourceNo, label: f.label, material: materialByNo.get(f.sourceNo) ?? "", existing: true }))
    ),
    ai,
    mechanicalOnly: writeSources.length === 0 && fresh.length === 0,
    excluded,
  });
  // 本文に書き足す素材が無ければ AI を呼ばない (費用をかけない)
  if (options.manual || (writeSources.length === 0 && fresh.length === 0)) {
    return { ok: true, proposal: proposal(plan.body, [], null) };
  }

  const prompt = mergePrompt({
    system: await mergeSystemPrompt(template, input),
    title: article.title,
    existingBody: plan.body,
    materials: renumbered.text,
    newSources: [...writeSources, ...fresh.map((f) => ({ sourceNo: f.sourceNo, label: f.label }))],
    included: materials.included,
    truncated: materials.truncated,
    // 場所のカードはおでかけだけ (場所候補を本文に使うテンプレートがほかに無い)
    ...(template.key === "outing" ? { places: placesText(input.places) } : {}),
  });

  let generated;
  try {
    generated = await generateMergeDraft(user, dossierId, template, prompt);
  } catch (e) {
    if (e instanceof ArticleAiError) return { ok: false, error: e.message };
    throw e;
  }
  const maxNo = Math.max(0, ...plan.renumber.values());
  const normalized = normalizeAiBody(unwrapFence(generated.body), maxNo);
  const body = template.key === "outing" ? expandPlaceCards(normalized, input.places) : normalized;
  const check = checkMerge(plan.body, body);
  if (!check.ok) return { ok: false, error: check.reason };
  return { ok: true, proposal: proposal(body, check.changedLines, generated.ai) };
}

export type SaveMergeResult =
  | { ok: true; shortId: string; sources: number; excluded: number; failed: string[]; /** 保存した本文 (番号を詰めたあと) */ body: string }
  | { ok: false; error: string };

/**
 * 人が直した案を保存する。本文で参照された新しい出典だけ足し (番号は詰めて振り直す)、
 * 参照されなかったものは「今後足さない」にする。人の手直しは検査しない
 */
export async function saveMerge(
  user: ActingUser,
  target: ArticleTarget,
  expectedDigest: string,
  body: string
): Promise<SaveMergeResult> {
  const actor: ArticleActor = { id: user.id };
  // 取り込んだ時刻は素材を読む前にする (読んだあとに入れたクリップは次の組み込みで拾う)
  const syncedAt = new Date();
  const { resolved, rendered, article, articleId, existingSources, plan, fresh } = await prepareMerge(user, target);
  if (mergeDigest(plan, fresh) !== expectedDigest) {
    return { ok: false, error: "案を作ったあとで素材か記事が変わりました。もう一度 AI に組み込ませてください" };
  }
  if (!body.trim()) return { ok: false, error: "本文が空です" };

  const sourceNos = new Set(existingSources.flatMap((s) => (s.sourceNo == null ? [] : [s.sourceNo])));
  const bodyNos = new Set([...article.body.matchAll(/\^\[(\d+)\]/g)].map((m) => Number(m[1])));
  // 本文に、見えない出典 (上位機密で RLS が読ませない) の番号がある。新しい出典の番号とぶつかると
  // 既存の脚注を新しい出典に付け替えてしまうので止める
  if (plan.newSources.some((s) => bodyNos.has(s.sourceNo) && !sourceNos.has(s.sourceNo))) {
    return { ok: false, error: "この記事には閲覧できない出典があり、番号がぶつかるため保存できません。クリアランスの高い人が保存してください" };
  }
  const final = finalizeMerge(body, plan.newSources, new Set([...sourceNos, ...bodyNos]));
  // 使わなかった出典のうち、差分で「足すもの」に出ていたもの (出典だけの提示) を除外にする
  const offered = new Set(plan.additions.map((a) => a.key));
  // 機械で足した行 (画像・トーク) を人が消したものも除外にする (消しても反映待ちに残り続けないように)
  const finalLines = new Set(final.body.split("\n").map((l) => l.replace(/\^\[\d+\]\s*$/, "").trim()));
  const removedLines = plan.additions
    .filter((a) => (a.kind === "talk" || a.kind === "blogImage") && !finalLines.has(a.label))
    .map((a) => a.key);
  const unusedKeys = [
    ...final.unused.flatMap((s) => (s.assetId ? [exclusionKey("source", s.assetId)] : [])).filter((k) => offered.has(k)),
    ...removedLines,
  ];

  // **出典が先。** 本文を先に書くと ^[n] の最大値の続きから番号が振られてリンク切れになる
  const applied = await applySources(article.shortId, articleId, final.sources, user, actor, article.updatedAt);
  // 何も足さなかった (全部使わないと決めた) なら本文は書かない (更新日と push 待ちを無駄に立てない)
  const unchanged = final.body === article.body && final.sources.length === 0;
  const updated = unchanged
    ? ({ ok: true } as const)
    : await updateArticle(
      article.shortId,
      applied.updatedAt,
      {
        title: article.title,
        type: article.type,
        tags: Array.isArray(article.tags) ? (article.tags as string[]) : [],
        body: final.body,
        date: article.date,
        dateDisplay: article.dateDisplay,
        dateMode: article.dateMode,
        publishedAt: article.publishedAt,
        articleUpdatedAt: parseFrontmatterDate(todayJst()),
        draft: article.draft,
        unlisted: article.unlisted,
        ongoing: article.ongoing,
      },
      actor
    );
  if (!updated.ok) {
    return {
      ok: false,
      error:
        updated.reason === "conflict"
          ? `記事が他で更新されました (出典 ${applied.applied} 件は足してあります)。記事の編集画面で確認してください`
          : "記事が見つかりません",
    };
  }
  // ドシエのスナップショット (要反映の判定) を今回の状態にする (`saveArticle` の追記と同じ)
  await saveFrontmatterExtra(articleId, refreshedExtra(resolved.template, rendered.frontmatterExtra));
  // 使わなかったメモ・抜粋も含めて取り込み済みにする (出典の「今後足さない」と同じ扱い)
  await markMaterialsSynced(articleId, syncedAt);
  await resolved.addExclusions(unusedKeys);
  await logAudit({
    actorId: user.id,
    action: `${resolved.audit.prefix}.ai_merge_save`,
    targetType: resolved.audit.targetType,
    targetId: resolved.audit.targetId,
    metadata: {
      shortId: article.shortId,
      sources: applied.applied,
      failed: applied.failed.length,
      excluded: unusedKeys,
      freshItems: fresh.flatMap((f) => f.itemIds),
    },
  });
  return { ok: true, shortId: article.shortId, sources: applied.applied, excluded: unusedKeys.length, failed: applied.failed, body: unchanged ? article.body : final.body };
}
