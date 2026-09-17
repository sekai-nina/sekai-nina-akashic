import { withClearance, prisma } from "@/lib/db";
import { accessibleClassifications, assertClearance, isAboveClearance } from "@/lib/classification";
import { logAudit } from "@/lib/domain/audit";
import { nextSortOrder, nextSourceNo } from "@/lib/articles/apply";
import {
  deriveArticlePath,
  generateShortId,
  parseArticleCreateInput,
  type ArticleCreateInput,
} from "@/lib/articles/create";
import {
  diffArticleEdit,
  parseArticleEditForm,
  toArticleEditValues,
  type ArticleEditField,
  type ArticleEditValues,
} from "@/lib/articles/edit";
import { mergeArticleEditPatch, type ArticleEditPatch } from "@/lib/articles/patch";
import { renderArticleMarkdown } from "@/lib/articles/frontmatter";
import { buildCommitMessage, planPush, type PushPlan, type RenderedArticle } from "@/lib/articles/push";
import { gitBlobSha } from "@/lib/github/blob";
import { todayJst } from "@/lib/utils";
import {
  commitFiles,
  getArticlesRepo,
  getBranchHead,
  getTreeBlobs,
  GithubApiError,
  isGithubConfigured,
  type BranchHead,
  type CommitResult,
} from "@/lib/github/client";
import {
  ArticleSourceStatus,
  ClearanceLevel,
  Prisma,
  type ArticleType,
  type TextType,
} from "@prisma/client";

/**
 * 記事 (世界新奈) の取得。
 *
 * Article 自体は非保護テーブルだが、ArticleSource は保護テーブルなので
 * clearance を通さないと無言で 0 行になる。両方まとめて withClearance の
 * 中で読む。
 */

export const ARTICLE_PAGE_SIZE = 30;

/**
 * 書き込みの主体。監査ログ (`article.update` / `article.source.apply`) は domain がここから書く
 * (他の domain 書き込みと同じ規約。呼び出し側が経路ごとに書くと 3 経路で重複する)。
 * API キー経路は `apiKeyId` を添える (人間の操作と区別するため)。
 */
export interface ArticleActor {
  id: string;
  apiKeyId?: string;
}

/** 監査ログの失敗で本体の書き込みを「失敗」にしない (既にコミット済み)。ログに残して先へ進む */
async function auditArticle(actor: ArticleActor, params: Omit<Parameters<typeof logAudit>[0], "actorId">) {
  await logAudit({
    actorId: actor.id,
    ...params,
    metadata: { ...(params.metadata ?? {}), ...(actor.apiKeyId ? { apiKeyId: actor.apiKeyId } : {}) },
  }).catch((e: unknown) => console.error(`${params.action} の監査ログに失敗:`, e));
}

export interface ListArticlesOptions {
  clearance: string;
  page?: number;
  perPage?: number;
  type?: ArticleType;
  /** タイトル・本文の部分一致 (pg_trgm + ILIKE) */
  q?: string;
  /** 下書きを含めるか (既定: 含める。公開サイトと違い内部ツールなので) */
  includeDraft?: boolean;
  /** unresolved な紐づけを持つ記事だけに絞る */
  onlyUnresolved?: boolean;
  /** pending (未反映) の紐づけを持つ記事だけに絞る。API の「反映待ちを探す」用 */
  onlyPending?: boolean;
  /**
   * pending として数える (`pendingCount` / `onlyPending`) classification の上限。API キー経路は
   * `API_APPLY_MAX_CLASSIFICATION` を渡す — それより上の行は API からは apply できず、詳細でも
   * 返さないので、一覧でも「作業がある」と見せない。画面は undefined (= RLS で見える行すべて)
   */
  pendingMaxClassification?: ClearanceLevel;
  /** 未 push (dirty) の記事だけに絞る */
  onlyDirty?: boolean;
}

export async function listArticles(opts: ListArticlesOptions) {
  const page = Math.max(1, opts.page ?? 1);
  const perPage = opts.perPage ?? ARTICLE_PAGE_SIZE;

  const where: Prisma.ArticleWhereInput = {};
  if (opts.type) where.type = opts.type;
  if (opts.includeDraft === false) where.draft = false;
  if (opts.q && opts.q.trim() !== "") {
    const q = opts.q.trim();
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { body: { contains: q, mode: "insensitive" } },
    ];
  }
  // pending の絞り込みと件数で同じ条件を使う
  const pendingWhere: Prisma.ArticleSourceWhereInput = {
    status: ArticleSourceStatus.pending,
    ...(opts.pendingMaxClassification
      ? { classification: { in: accessibleClassifications(opts.pendingMaxClassification) } }
      : {}),
  };
  const isPending = (s: { status: ArticleSourceStatus; classification: ClearanceLevel }) =>
    s.status === ArticleSourceStatus.pending &&
    (!opts.pendingMaxClassification || !isAboveClearance(s.classification, opts.pendingMaxClassification));

  // 両方指定されたら AND (片方が黙って消えないように)。RLS 下で評価されるので、
  // 見えない pending 行しか無い記事は「pending なし」になる (意図どおり)
  const sourceFilters: Prisma.ArticleWhereInput[] = [];
  if (opts.onlyUnresolved) sourceFilters.push({ sources: { some: { status: ArticleSourceStatus.unresolved } } });
  if (opts.onlyPending) sourceFilters.push({ sources: { some: pendingWhere } });
  if (sourceFilters.length) where.AND = sourceFilters;
  if (opts.onlyDirty) where.dirty = true;

  return withClearance(opts.clearance, async (tx) => {
    const [items, total] = await Promise.all([
      tx.article.findMany({
        where,
        // Postgres の DESC は NULL を **先頭** に置く。素の desc だと日付の無い
        // 下書きが一覧の先頭を占め、新しい記事が見えなくなる
        orderBy: [{ publishedAt: { sort: "desc", nulls: "last" } }, { title: "asc" }],
        skip: (page - 1) * perPage,
        take: perPage,
        select: {
          id: true,
          shortId: true,
          path: true,
          title: true,
          type: true,
          tags: true,
          publishedAt: true,
          articleUpdatedAt: true,
          draft: true,
          unlisted: true,
          dirty: true,
          editedAt: true,
          updatedAt: true,
          // 件数だけ要るが `_count` は relation ごとに 1 条件しか持てない (総数と pending 数を
          // 同時に取れない)。1 記事 3 行程度なので status だけ引いて数える
          sources: { select: { status: true, classification: true } },
        },
      }),
      tx.article.count({ where }),
    ]);
    return {
      items: items.map(({ sources, ...a }) => ({
        ...a,
        sourceCount: sources.length,
        // 反映待ちの件数。API の一覧で「どの記事に作業が残っているか」を見せる
        pendingCount: sources.filter(isPending).length,
      })),
      total,
      page,
      perPage,
    };
  });
}

/** 記事詳細の形 (`ArticleSource` は保護テーブルなので `withClearance` の中でしか読まない) */
const ARTICLE_DETAIL_INCLUDE = {
  sources: {
    // pending 行の sortOrder は apply 後の行と同値になりうる (nextSortOrder は非 pending だけで
    // 採る)。同値の並びが不定にならないよう紐づけた順で安定させる
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: {
      asset: {
        select: {
          id: true,
          title: true,
          kind: true,
          canonicalDate: true,
          thumbnailUrl: true,
          classification: true,
        },
      },
    },
  },
} satisfies Prisma.ArticleInclude;

export type ArticleDetailRow = Prisma.ArticleGetPayload<{ include: typeof ARTICLE_DETAIL_INCLUDE }>;

export async function getArticleByShortId(shortId: string, clearance: string): Promise<ArticleDetailRow | null> {
  return withClearance(clearance, (tx) => tx.article.findUnique({ where: { shortId }, include: ARTICLE_DETAIL_INCLUDE }));
}

/**
 * 紐づけ用の軽量な記事一覧 (ピッカーに渡す)。
 *
 * Article は非保護テーブルなので withClearance は不要 (トランザクション 1 本分の
 * 往復が丸ごと無駄になる)。shortId はピッカーで使わないので select しない
 * (332 件 × 7 文字でペイロードが無駄に膨らむ)。
 */
export async function listArticlesForPicker() {
  return prisma.article.findMany({
    orderBy: [{ title: "asc" }],
    select: { id: true, title: true, type: true },
  });
}

/**
 * 記事タイトル → shortId。本文の `[[記事タイトル]]` を解決するのに使う。
 *
 * Article は非保護テーブルなので withClearance は不要。332 行 × 2 列なので
 * 全件引いて構わない (リンクは 1 記事に複数あり、都度引くと N+1 になる)。
 */
export async function getArticleTitleIndex(): Promise<Map<string, string>> {
  // orderBy が無いと Postgres の返す行順が不定になり、同名タイトルのとき
  // リクエストごとに飛び先が変わる (実データに 1 組あり、実際にリンクされている)
  const rows = await prisma.article.findMany({
    select: { shortId: true, title: true },
    orderBy: { shortId: "asc" },
  });
  const map = new Map<string, string>();
  // 同名タイトルは先勝ち。どちらに飛ぶかは曖昧だが、決め打ちで安定させる
  for (const r of rows) if (r.title && !map.has(r.title)) map.set(r.title, r.shortId);
  return map;
}

export interface AddAssetToArticleInput {
  articleId: string;
  assetId: string;
  label?: string;
  excerpt?: string;
  excerptType?: TextType;
  excerptStart?: number;
  excerptEnd?: number;
}

/**
 * アセット (と抜粋) を記事に紐づける。
 *
 * status は常に pending。applied は「記事本文に反映済み」を意味するので、
 * 本文へ反映する処理 (AI / 人) が別途 applied に遷移させる。
 *
 * DossierItem と同じく、同一アセットを抜粋ごとに複数回紐づけられる
 * (= 重複チェックをしない)。
 *
 * **classification は元アセットから継承する。** ArticleSource の RLS は
 * 自テーブルの classification しか見ない (親アセットと連動しない) ため、
 * internal 決め打ちにすると confidential なアセットの抜粋が internal に
 * 格下げされて下位クリアランスから読めてしまう。記事詳細は asset が RLS で
 * 落ちても label / excerpt は表示するので、実際に漏れる経路になる。
 */
export async function addAssetToArticle(input: AddAssetToArticleInput, clearance: string) {
  return withClearance(clearance, async (tx) => {
    // RLS 下で引くので、見えないアセットは null になる (= 存在確認を兼ねる)
    const asset = await tx.asset.findUnique({
      where: { id: input.assetId },
      select: { classification: true },
    });
    if (!asset) throw new Error("Asset not found or not accessible");

    // RLS は読みを守るが、自分より上のクリアランスを付けて書く操作は
    // アプリ層で止める (このリポジトリの規約)
    assertClearance(clearance, asset.classification);

    const last = await tx.articleSource.findFirst({
      where: { articleId: input.articleId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    return tx.articleSource.create({
      data: {
        articleId: input.articleId,
        assetId: input.assetId,
        status: ArticleSourceStatus.pending,
        label: input.label ?? "",
        excerpt: input.excerpt ?? "",
        excerptType: input.excerptType,
        excerptStart: input.excerptStart,
        excerptEnd: input.excerptEnd,
        sortOrder: (last?.sortOrder ?? -1) + 1,
        classification: asset.classification,
      },
      select: { id: true, articleId: true },
    });
  });
}

/**
 * 紐づけの削除。
 *
 * **pending のものだけ消せる。** applied は取り込み由来で記事本文の脚注と
 * 対応しており、消すと出典が壊れる。UI では pending にしかボタンを出して
 * いないが、Server Action は任意の id を受け取れるのでサーバ側で担保する。
 */
export async function removeArticleSource(id: string, clearance: string) {
  const { count } = await withClearance(clearance, (tx) =>
    tx.articleSource.deleteMany({ where: { id, status: ArticleSourceStatus.pending } }),
  );
  if (count === 0) throw new Error("削除できる紐づけが見つかりません (pending のみ削除可)");
}

export interface ApplyArticleSourceInput {
  shortId: string;
  sourceId: string;
  /** 楽観ロック。呼び出し側が記事を読んだ時点の `Article.updatedAt` */
  expectedUpdatedAt: Date;
  /**
   * public に下げてよい classification の上限。API キー経路 (REST / MCP) は
   * `API_APPLY_MAX_CLASSIFICATION` (internal) を渡す。画面 (人間) は undefined = 上限なし
   * (RLS と `assertClearance` だけ)
   */
  maxClassification?: ClearanceLevel;
  actor: ArticleActor;
}

type ApplyFailure =
  | { reason: "not_found" | "not_pending" | "asset_missing" | "above_limit" }
  /** 呼び出し側が読み直さずに再試行できるよう、衝突時は現在の `updatedAt` を添える */
  | { reason: "conflict"; currentUpdatedAt: Date };

export type ApplyArticleSourceResult =
  | { ok: true; sourceNo: number; updatedAt: Date; previousClassification: ClearanceLevel }
  | ({ ok: false } & ApplyFailure);

/** `applyArticleSource` のトランザクションを巻き戻すための印。外に出さず結果に変換する */
class ApplyAbort extends Error {
  constructor(readonly failure: ApplyFailure) {
    super(failure.reason);
  }
}

/**
 * 紐づけ (pending) を「本文に反映済み」(applied) にする。REST / MCP / 画面の 3 経路がこれを呼ぶ。
 *
 * **これは公開を決める操作。** frontmatter に載るのは「pending 以外 かつ public」の行だけ
 * (`buildFrontmatter`) なので、applied にすると同時に classification を **public に下げる**。
 * 次の push でこの行の label / ref が公開リポジトリに出る。`excerpt` / `note` はそのまま残す
 * (どの箇所を根拠にした脚注かを後から辿るため。public 行になるので akashic 内では誰でも
 * 読める = 抜粋ごと公開判断、が規約。`docs/security-dev.md`)。
 *
 * - RLS 下で引くので、クリアランスを超える行は見えない (= `not_found`)。加えて `assertClearance`
 *   で「自分より上を public に下げる」操作をアプリ層でも止める (このリポジトリの規約)
 * - **ガードは行の classification と元アセットの現在の classification の両方に掛ける。**
 *   行の値は紐づけ時のスナップショットで、後からアセットを confidential に上げても伝播しない
 *   (`updateAsset` は ArticleSource を触らない)。アセットが RLS で見えない (関係が null なのに
 *   `assetId` はある) ときも `not_found`
 * - `maxClassification` を超える行 (またはアセット) は `above_limit`。API キーからは internal 以下しか
 *   公開化できない (`docs/api.md` の「引き下げ不可」の例外。confidential 以上は画面から人間が押す)
 * - 脚注番号は `nextSourceNo` (既存の番号と本文の `^[n]` の最大 + 1)、並びは `nextSortOrder`
 *   (非 pending 行の末尾)。`label` が空なら asset のタイトルで埋める (旧 sync-sources.ts と同じ)。
 *   `url` / `date` は捏造しない
 * - 出典が frontmatter に載るようになる = push の出力が変わるので、Article に `dirty = true` と
 *   `editedAt = now` を立てる (規約)。`updateMany` の where に `expectedUpdatedAt` を入れ、0 行なら
 *   **トランザクションごと巻き戻して `conflict`**。apply 自身が `updatedAt` を進めるので、
 *   別の apply や保存が割り込んで番号がズレる競合はこれで検出できる
 * - 呼び出し側は返った `sourceNo` で本文に `^[n]` を書く (apply → 本文の順。逆だと途中で
 *   止まったとき本文に宛先の無い脚注が残る)
 * - 監査ログ `article.source.apply` はここで書く (3 経路共通)
 */
export async function applyArticleSource(
  input: ApplyArticleSourceInput,
  clearance: string,
): Promise<ApplyArticleSourceResult> {
  const result = await applyArticleSourceTx(input, clearance);
  if (result.ok) {
    await auditArticle(input.actor, {
      action: "article.source.apply",
      targetType: "ArticleSource",
      targetId: input.sourceId,
      metadata: {
        shortId: input.shortId,
        sourceNo: result.sourceNo,
        previousClassification: result.previousClassification,
      },
    });
  }
  return result;
}

async function applyArticleSourceTx(
  input: ApplyArticleSourceInput,
  clearance: string,
): Promise<ApplyArticleSourceResult> {
  try {
    return await withClearance(clearance, async (tx) => {
      const article = await tx.article.findUnique({
        where: { shortId: input.shortId },
        select: {
          id: true,
          body: true,
          updatedAt: true,
          sources: {
            where: { status: { not: ArticleSourceStatus.pending } },
            select: { sourceNo: true, sortOrder: true },
          },
        },
      });
      if (!article) throw new ApplyAbort({ reason: "not_found" });
      // 衝突なら出典の行を触る前に返す (書くときにも where で二重に見る)
      if (article.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        throw new ApplyAbort({ reason: "conflict", currentUpdatedAt: article.updatedAt });
      }

      const source = await tx.articleSource.findUnique({
        where: { id: input.sourceId },
        select: {
          articleId: true,
          status: true,
          classification: true,
          label: true,
          assetId: true,
          asset: { select: { title: true, classification: true } },
        },
      });
      if (!source || source.articleId !== article.id) throw new ApplyAbort({ reason: "not_found" });
      if (source.status !== ArticleSourceStatus.pending) throw new ApplyAbort({ reason: "not_pending" });
      // 紐づけた後に Asset が消されて SetNull された行。ref の無い出典を公開しても意味がない
      if (!source.assetId) throw new ApplyAbort({ reason: "asset_missing" });
      // FK があるので「assetId はあるのに関係が null」= RLS で見えていない。見えないものは公開しない
      if (!source.asset) throw new ApplyAbort({ reason: "not_found" });
      for (const classification of [source.classification, source.asset.classification]) {
        assertClearance(clearance, classification);
        if (input.maxClassification && isAboveClearance(classification, input.maxClassification)) {
          throw new ApplyAbort({ reason: "above_limit" });
        }
      }

      const sourceNo = nextSourceNo(
        article.sources.map((s) => s.sourceNo),
        article.body,
      );
      const sortOrder = nextSortOrder(article.sources.map((s) => s.sortOrder));

      await tx.articleSource.update({
        where: { id: input.sourceId },
        data: {
          status: ArticleSourceStatus.applied,
          classification: ClearanceLevel.public,
          sourceNo,
          sortOrder,
          label: source.label || source.asset?.title || "",
        },
      });
      // 更新後の updatedAt は呼び出し側が次の書き込み (本文の PATCH) に使う。
      // 0 行 = 読んでから書くまでに別の保存が入った (巻き戻して衝突)
      const [after] = await tx.article.updateManyAndReturn({
        where: { id: article.id, updatedAt: input.expectedUpdatedAt },
        data: { dirty: true, editedAt: new Date() },
        select: { updatedAt: true },
      });
      if (!after) {
        const current = await tx.article.findUniqueOrThrow({ where: { id: article.id }, select: { updatedAt: true } });
        throw new ApplyAbort({ reason: "conflict", currentUpdatedAt: current.updatedAt });
      }
      return {
        ok: true as const,
        sourceNo,
        updatedAt: after.updatedAt,
        previousClassification: source.classification,
      };
    });
  } catch (e) {
    if (e instanceof ApplyAbort) return { ok: false, ...e.failure };
    throw e;
  }
}

/** 記事一覧の上部に出すサマリー (種別ごとの件数と未解決の総数) */
export async function getArticleStats(clearance: string) {
  return withClearance(clearance, async (tx) => {
    const [byType, total, unresolved, dirty] = await Promise.all([
      tx.article.groupBy({ by: ["type"], _count: true }),
      tx.article.count(),
      tx.articleSource.count({ where: { status: ArticleSourceStatus.unresolved } }),
      tx.article.count({ where: { dirty: true } }),
    ]);
    return { byType, total, unresolved, dirty };
  });
}

/**
 * タグ入力の候補。全記事の tags を件数の多い順に並べる (同数は名前順)。
 *
 * Article は非保護テーブルなので素の prisma でよい。335 行 × Json 1 列なので全件引く
 * (タグは 158 種で、表記揺れを防ぐには既存の並びをそのまま候補にするのが確実)。
 */
export async function listArticleTags(): Promise<string[]> {
  const rows = await prisma.article.findMany({ select: { tags: true } });
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!Array.isArray(r.tags)) continue;
    for (const t of r.tags as unknown[]) {
      const tag = String(t);
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"))
    .map(([tag]) => tag);
}

export type UpdateArticleResult =
  | { ok: true; changed: ArticleEditField[]; previousTitle: string; updatedAt: Date }
  | { ok: false; reason: "not_found" }
  /** 呼び出し側が読み直さずに再試行できるよう、衝突時は現在の `updatedAt` を添える */
  | { ok: false; reason: "conflict"; currentUpdatedAt: Date };

/** 編集で読む列。`ArticleEditValues` に落とすのに要るもの + 楽観ロックの `updatedAt` */
const ARTICLE_EDIT_SELECT = {
  title: true,
  type: true,
  tags: true,
  body: true,
  date: true,
  dateDisplay: true,
  dateMode: true,
  publishedAt: true,
  articleUpdatedAt: true,
  draft: true,
  unlisted: true,
  ongoing: true,
  updatedAt: true,
} satisfies Prisma.ArticleSelect;

type ArticleEditRow = Prisma.ArticleGetPayload<{ select: typeof ARTICLE_EDIT_SELECT }>;

/**
 * 記事の編集を保存する (`/articles/[shortId]/edit`)。
 *
 * - **楽観ロック**: フォームが読み込んだ時点の `updatedAt` を持ち、`updateMany` の where に
 *   入れて 0 行なら `conflict`。別の保存か取り込みが先に入った場合で、呼び出し側は入力を
 *   保ったままエラーを見せる。push は素の SQL で `updatedAt` を動かさないので、push を
 *   挟んでも保存できる (編集後の内容は次の push に載る)
 * - **変わっていなければ書かない**: `dirty` / `editedAt` を立てるのは push の出力が変わる
 *   ときだけ。何もせず保存しても push 画面に出ない
 * - 書く内容は変更カラム + `dirty = true` + `editedAt = now` (`docs/security-dev.md` の規約。
 *   `editedAt` は「未 push の akashic 編集がある」の印で、取り込みの preserved ガードが見る)
 *
 * Article は非保護テーブルなので素の prisma。呼び出し側 (Server Action) が役割を確認する。
 * API の部分更新 (`patchArticle`) も現在値を読んだ後はここに合流する。監査ログ `article.update`
 * は変更があったときにここで書く (3 経路共通)。
 */
export async function updateArticle(
  shortId: string,
  expectedUpdatedAt: Date,
  values: ArticleEditValues,
  actor: ArticleActor,
): Promise<UpdateArticleResult> {
  const current = await prisma.article.findUnique({ where: { shortId }, select: ARTICLE_EDIT_SELECT });
  if (!current) return { ok: false, reason: "not_found" };
  return updateArticleFrom(shortId, current, expectedUpdatedAt, values, actor);
}

async function updateArticleFrom(
  shortId: string,
  current: ArticleEditRow,
  expectedUpdatedAt: Date,
  values: ArticleEditValues,
  actor: ArticleActor,
): Promise<UpdateArticleResult> {
  if (current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
    return { ok: false, reason: "conflict", currentUpdatedAt: current.updatedAt };
  }

  const changed = diffArticleEdit(toArticleEditValues(current), values);
  if (!changed.length) return { ok: true, changed, previousTitle: current.title, updatedAt: current.updatedAt };

  // 読んでから書くまでに別の保存が入ると、上の比較だけでは検出できない。where にも入れる。
  // 更新後の updatedAt は API の呼び出し側が続けて書くときに使う
  const [after] = await prisma.article.updateManyAndReturn({
    where: { shortId, updatedAt: expectedUpdatedAt },
    data: { ...values, dirty: true, editedAt: new Date() },
    select: { updatedAt: true },
  });
  if (!after) {
    const now = await prisma.article.findUniqueOrThrow({ where: { shortId }, select: { updatedAt: true } });
    return { ok: false, reason: "conflict", currentUpdatedAt: now.updatedAt };
  }
  await auditArticle(actor, {
    action: "article.update",
    targetType: "Article",
    targetId: shortId,
    metadata: { changed },
  });
  return { ok: true, changed, previousTitle: current.title, updatedAt: after.updatedAt };
}

export type PatchArticleResult =
  | UpdateArticleResult
  | { ok: false; reason: "invalid"; errors: Partial<Record<ArticleEditField, string>> };

/**
 * 外部 (REST / MCP) からの部分更新。
 *
 * 現在値に `patch` を重ねてフォームの形にし (`mergeArticleEditPatch`)、UI と同じ
 * `parseArticleEditForm` → `updateArticleFrom` を通す。正規化・検証・変更検出・dirty / editedAt の
 * 立て方が UI と同じになる。`updatedAt` の楽観ロックも同じ (API は body で必須)。
 * 衝突は入力の検証より先に返す (古い値の上に組み立てた入力を検証しても意味がない)。
 */
export async function patchArticle(
  shortId: string,
  expectedUpdatedAt: Date,
  patch: ArticleEditPatch,
  actor: ArticleActor,
): Promise<PatchArticleResult> {
  const current = await prisma.article.findUnique({ where: { shortId }, select: ARTICLE_EDIT_SELECT });
  if (!current) return { ok: false, reason: "not_found" };
  if (current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
    return { ok: false, reason: "conflict", currentUpdatedAt: current.updatedAt };
  }

  const parsed = parseArticleEditForm(mergeArticleEditPatch(toArticleEditValues(current), patch));
  if (!parsed.ok) return { ok: false, reason: "invalid", errors: parsed.errors };
  return updateArticleFrom(shortId, current, expectedUpdatedAt, parsed.values, actor);
}

export type CreateArticleResult =
  | { ok: true; article: ArticleDetailRow }
  /** `parseArticleEditForm` の検証 (暦に無い日付 / 本文の長さ / dateMode) */
  | { ok: false; reason: "invalid"; errors: Partial<Record<ArticleEditField, string>> }
  /** タイトルから path を導出できない (`deriveArticlePath`) */
  | { ok: false; reason: "invalid_path"; error: string }
  /** 同じ path の記事が既にある。呼び出し側はその shortId を PATCH すればよい */
  | { ok: false; reason: "path_exists"; path: string; existingShortId: string; existingTitle: string }
  /** DB には無いが公開リポジトリに同じ path のファイルがある。取り込んでからでないと作れない */
  | { ok: false; reason: "path_exists_upstream"; path: string };

/**
 * `shortId` の `@unique` 衝突で再採番する上限。62^7 ≈ 3.5 兆通りに対して 335 本なので
 * 実質 1 回で決まる。上限に達したら乱数か DB がおかしいので投げる
 */
const SHORT_ID_ATTEMPTS = 5;

/**
 * P2002 が `meta.target` で示す衝突先に列名が含まれるか。
 *
 * Postgres + prisma-client-js は列名の配列 (`["path"]`) を返すが、制約名 (`"Article_path_key"`)
 * を返す構成もある。どちらでも同じ分岐に入るよう部分一致で見る (外すと path 衝突が 409 ではなく
 * 500 になる)。
 */
function isUniqueViolationOn(e: Prisma.PrismaClientKnownRequestError, column: string): boolean {
  const target = e.meta?.target;
  const parts = Array.isArray(target) ? target.map(String) : typeof target === "string" ? [target] : [];
  return parts.some((t) => t.includes(column));
}

/**
 * 公開リポジトリ側に同じ path のファイルがあるか (DB には無いもの)。
 *
 * **これを見ないと取り込みが止まる。** 上流にあって DB に無いファイル (Obsidian で足して未取り込み /
 * `short_id` が無くて取り込まれない) と同じ path で作ると、
 *
 * - `planPush` は tree に path があるのに `githubSha` が null なので `not_imported` 扱いにし、
 *   その記事は永久に push できない
 * - 次の `pnpm cli:import-articles` は `pathConflicts` で **取り込み全体を中断する**
 *   (`src/cli/import-articles.ts`。DB の行を人が消すまで 1 本も取り込めない)
 *
 * GitHub 未設定なら見ない (ローカル開発)。読みに失敗したときも作成は止めない — 記事の作成が
 * GitHub の可用性に依存すると、トークン失効で書き込み経路ごと死ぬ。DB 側の検査は効いたままなので
 * fail-open で構わない。比較は DB と同じく大文字小文字を無視する。
 */
async function pathExistsUpstream(path: string): Promise<boolean> {
  if (!isGithubConfigured()) return false;
  try {
    const { tree } = await readUpstream();
    const lower = path.toLowerCase();
    for (const p of tree.keys()) if (p.toLowerCase() === lower) return true;
    return false;
  } catch (e) {
    console.error("記事作成時の GitHub tree 照会に失敗 (作成は続行):", e);
    return false;
  }
}

/**
 * 外部 (REST `POST /api/v1/articles` / MCP `akashic_create_article`) からの記事の新規作成。
 *
 * 採番規則と既定値は `src/lib/articles/create.ts` (#104)。入力は PATCH と同じ経路
 * (`mergeArticleEditPatch` → `parseArticleEditForm`) で `ArticleEditValues` にするので、
 * 正規化と検証が編集 UI / PATCH とズレない。
 *
 * - `shortId` はサーバが採番し、`@unique` 衝突 (P2002) なら再採番する
 * - `path` の衝突は create の前に DB と公開リポジトリの両方で見る (`path_exists` /
 *   `path_exists_upstream`)。読んでから書くまでに同じ path が作られた場合は create の P2002 で
 *   同じ結果にする
 * - 書く内容は `dirty = true` / `editedAt = now` / `githubSha = null` (規約。`githubSha` が null で
 *   GitHub の tree に path が無ければ `planPush` が新規ファイルとして push する)。`slug` は null、
 *   `frontmatterExtra` は `{}`
 * - 出典 (`ArticleSource`) は作らない。紐づけは別経路 (#110)
 * - 監査ログ `article.create` はここで書く (REST / MCP 共通)
 *
 * Article は非保護テーブルなので素の prisma。詳細と同じ形で返すために `sources` を足すが、
 * **`include` では引かない** — 保護テーブルを素の prisma で読むと RLS で無言の 0 行になり、
 * 「作成直後だから空」と「RLS で消えた」が型の上で区別できなくなる。空なのは事実なので直に置く。
 */
export async function createArticle(input: ArticleCreateInput, actor: ArticleActor): Promise<CreateArticleResult> {
  const derived = deriveArticlePath(input.type, input.title);
  if (!derived.ok) return { ok: false, reason: "invalid_path", error: derived.error };
  const parsed = parseArticleCreateInput(input, todayJst());
  if (!parsed.ok) return { ok: false, reason: "invalid", errors: parsed.errors };

  const pathExists = async (): Promise<CreateArticleResult | null> => {
    // 大文字小文字を無視して見る。`@@unique` は区別するので DB には両方入るが、
    // macOS (case-insensitive な APFS) の checkout は片方しか実体化できず、取り込みと
    // git status が永久に食い違う。Prisma の insensitive equals は `_` をワイルドカードに
    // しない (実測) ので path をそのまま渡してよい
    const owner = await prisma.article.findFirst({
      where: { path: { equals: derived.path, mode: "insensitive" } },
      select: { shortId: true, path: true, title: true },
    });
    // 既存のタイトルも返す: 全角置換は多対一なので「違う記事の本文を PATCH で潰す」判断材料が要る
    return owner
      ? { ok: false, reason: "path_exists", path: owner.path, existingShortId: owner.shortId, existingTitle: owner.title }
      : null;
  };
  const existing = await pathExists();
  if (existing) return existing;
  const upstream = await pathExistsUpstream(derived.path);
  if (upstream) return { ok: false, reason: "path_exists_upstream", path: derived.path };

  for (let attempt = 1; ; attempt++) {
    const shortId = generateShortId();
    try {
      const created = await prisma.article.create({
        data: {
          shortId,
          path: derived.path,
          slug: null,
          ...parsed.values,
          frontmatterExtra: {},
          githubSha: null,
          dirty: true,
          editedAt: new Date(),
        },
      });
      const article: ArticleDetailRow = { ...created, sources: [] };
      await auditArticle(actor, {
        action: "article.create",
        targetType: "Article",
        targetId: shortId,
        metadata: { path: derived.path, title: article.title, type: article.type },
      });
      return { ok: true, article };
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
      if (isUniqueViolationOn(e, "path")) {
        // 読んでから書くまでに同じ path が作られた。owner が引けないのは消された直後なので投げる
        const raced = await pathExists();
        if (raced) return raced;
        throw e;
      }
      if (!isUniqueViolationOn(e, "shortId")) throw e;
      // 「重複しているので更新ツールを使え」と読める P2002 のままにしない (そんな記事は無い)
      if (attempt >= SHORT_ID_ATTEMPTS) {
        throw new Error(`shortId を ${SHORT_ID_ATTEMPTS} 回採番しても空きが見つかりませんでした`);
      }
    }
  }
}

/**
 * タイトルを `[[title]]` / `[[title|表示]]` で参照している他の記事数。
 *
 * タイトルを変えた直後の警告に使う (宛先を失うリンクの数)。`remarkWikilinks` の解決は
 * タイトルの完全一致なので、ここも大文字小文字を区別する素の contains でよい。
 * Article は非保護テーブルなので素の prisma。
 */
export async function countArticlesLinkingTo(title: string, excludeShortId: string): Promise<number> {
  if (!title) return 0;
  return prisma.article.count({
    where: {
      shortId: { not: excludeShortId },
      OR: [{ body: { contains: `[[${title}]]` } }, { body: { contains: `[[${title}|` } }],
    },
  });
}

/**
 * push (GitHub への書き出し) で記事を読むときのクリアランス。**public 固定。**
 *
 * 操作者の clearance で読むと、RLS は高クリアランスほど多く返すので
 * 「restricted の担当者が push したときだけ機密アセットの label が公開リポジトリに
 * 出る」経路になる。誰が押しても同じ出力になるよう、読み出しは固定の最低
 * クリアランスで行い、`buildFrontmatter` の絞り込み (pending 以外かつ public) と
 * 二重にする。
 */
export const PUSH_CLEARANCE = ClearanceLevel.public;

export type { RenderedArticle } from "@/lib/articles/push";

/**
 * 条件に合う記事をまとめて push 用の Markdown に組み立てる。
 *
 * `PUSH_CLEARANCE` で読むので、RLS が非 public の ArticleSource を落とす。
 * それだけだと「applied なのに internal」の矛盾行が黙って消えて脚注が壊れた記事が
 * 公開されるため、矛盾の検出は **最高クリアランス (restricted)** で行う。
 * `prismaInternal` で数えない理由: `DIRECT_URL` 未設定だと `DATABASE_URL` に
 * 無言でフォールバックし、RLS で常に 0 件 = 「矛盾なし」になる (fail-open)。
 * `withClearance` なら環境変数に依らず全行が見える。
 *
 * restricted 側では記事ごとの「pending 以外の総数」も数え、public で見えた行数 +
 * blocked と一致することを確かめる。RLS はここでは「public 行が返ってくる」方向に
 * 頼っているので、`app.clearance` が効いていない等で行が落ちると、脚注を全部失った
 * 記事を 1 コミットで公開してしまう。件数が合わなければ黙って進めず止める。
 *
 * 読み出しと矛盾検出は別トランザクションなので、同時に `addAssetToArticle` が
 * 走ると別時点のスナップショットになる。push は人手の低頻度操作なので許容する
 * (`pushDirtyArticles` は commit 直前にこの関数を呼び直す)。
 *
 * 記事数ぶんトランザクションを張らない (334 本を `Promise.all` で投げると
 * pooler の接続を記事数ぶん占有する)。条件に合う記事を 2 トランザクションで引いて
 * メモリ上で組み立てる。
 */
export async function renderArticlesForPush(where: Prisma.ArticleWhereInput): Promise<RenderedArticle[]> {
  const articles = await withClearance(PUSH_CLEARANCE, (tx) =>
    tx.article.findMany({
      where,
      orderBy: { path: "asc" },
      include: {
        sources: {
          orderBy: [{ sortOrder: "asc" }],
          select: {
            assetId: true,
            status: true,
            classification: true,
            sourceNo: true,
            label: true,
            url: true,
            date: true,
            originalRef: true,
            sortOrder: true,
          },
        },
      },
    }),
  );
  if (!articles.length) return [];

  const ids = articles.map((a) => a.id);
  const [blockedRows, totals] = await withClearance(ClearanceLevel.restricted, (tx) =>
    Promise.all([
      tx.articleSource.findMany({
        where: {
          articleId: { in: ids },
          status: { not: ArticleSourceStatus.pending },
          classification: { not: ClearanceLevel.public },
        },
        orderBy: [{ sortOrder: "asc" }],
        select: { articleId: true, sourceNo: true },
      }),
      tx.articleSource.groupBy({
        by: ["articleId"],
        where: { articleId: { in: ids }, status: { not: ArticleSourceStatus.pending } },
        _count: { _all: true },
      }),
    ]),
  );
  const blockedByArticle = new Map<string, (number | null)[]>();
  for (const row of blockedRows) {
    const list = blockedByArticle.get(row.articleId);
    if (list) list.push(row.sourceNo);
    else blockedByArticle.set(row.articleId, [row.sourceNo]);
  }
  const totalByArticle = new Map(totals.map((t) => [t.articleId, t._count._all]));

  return articles.map((article) => {
    const base = {
      id: article.id,
      shortId: article.shortId,
      path: article.path,
      title: article.title,
      githubSha: article.githubSha,
      updatedAt: article.updatedAt,
    };
    const blockedSourceNos = blockedByArticle.get(article.id) ?? [];

    // public で見えた行 (pending を除く) + 非 public の行 = 全行、でなければ RLS が
    // 期待どおりに効いていない。**バッチ全体を止める** (1 本だけ飛ばして続けると、
    // 同じ原因で他の記事も脚注が欠けている可能性が高い)
    const visible = article.sources.filter((s) => s.status !== ArticleSourceStatus.pending).length;
    const total = totalByArticle.get(article.id) ?? 0;
    if (visible + blockedSourceNos.length !== total) {
      throw new Error(
        `ArticleSource の行数が合いません (${article.path}: public ${visible} + blocked ${blockedSourceNos.length} ≠ ${total})。RLS の設定を確認してください`,
      );
    }
    if (blockedSourceNos.length) return { ...base, ok: false as const, blockedSourceNos };

    const { markdown, blocked } = renderArticleMarkdown(article);
    // PUSH_CLEARANCE が public なら RLS が先に落とすので、ここに非 public 行が
    // 残っているのは RLS が効いていない証拠。上と同じくバッチ全体を止める
    if (blocked.length) {
      throw new Error(`RLS を通過した非 public の ArticleSource があります (${article.path})`);
    }
    return { ...base, ok: true as const, markdown, blobSha: gitBlobSha(markdown) };
  });
}

/** 記事 1 本を push 用の Markdown に組み立てる (`renderArticlesForPush` の単体版) */
export async function renderArticleForPush(shortId: string): Promise<RenderedArticle | null> {
  const [rendered] = await renderArticlesForPush({ shortId });
  return rendered ?? null;
}

/** GitHub の先頭と tree をまとめて読む (計画と実行で同じ形を使う) */
async function readUpstream(): Promise<{ head: BranchHead; tree: Map<string, string> }> {
  const head = await getBranchHead();
  return { head, tree: await getTreeBlobs(head.treeSha) };
}

/** `/articles/push` の表示用。GitHub の状態によって 3 通り */
export type PushPreview =
  | { state: "unconfigured"; repo: string; dirtyCount: number }
  | { state: "error"; repo: string; dirtyCount: number; message: string }
  | { state: "ready"; repo: string; head: BranchHead; plan: PushPlan };

/**
 * dirty な記事を全件組み立て、GitHub 側の tree と突き合わせて計画を作る (書き込まない)。
 *
 * 実行 (`pushDirtyArticles`) はこの結果を使い回さず、commit 直前にもう一度
 * 読み直す。表示と実行の間に編集や別経路の push が入っても古い計画で書かないため。
 */
export async function previewArticlePush(): Promise<PushPreview> {
  const repo = getArticlesRepo();
  if (!isGithubConfigured()) {
    return { state: "unconfigured", repo, dirtyCount: await prisma.article.count({ where: { dirty: true } }) };
  }
  // DB の組み立てと GitHub の読みは独立なので並べる。GitHub 側の失敗 (トークン無効・
  // 接続不可) は画面に出す情報なので値として受け、それ以外はそのまま投げる
  const [rendered, upstream] = await Promise.all([
    renderArticlesForPush({ dirty: true }),
    readUpstream().then(
      (u) => ({ ok: true as const, ...u }),
      (e: unknown) => {
        if (e instanceof GithubApiError) return { ok: false as const, error: e };
        throw e;
      },
    ),
  ]);
  if (!upstream.ok) return { state: "error", repo, dirtyCount: rendered.length, message: upstream.error.message };
  return { state: "ready", repo, head: upstream.head, plan: planPush(rendered, upstream.tree) };
}

export interface PushArticlesResult {
  /** コミットに載せた記事数 */
  pushed: number;
  /** GitHub 側と同じ内容だったので dirty だけ落とした記事数 */
  unchanged: number;
  /** 非 public の出典があり除外した記事数 */
  blocked: number;
  /** 衝突で除外した記事数 */
  conflicts: number;
  /** 1 本も push しなかったときは null */
  commit: CommitResult | null;
  /**
   * commit は GitHub に載ったが、その後の DB 更新 (dirty / githubSha) に失敗した。
   * 呼び出し側はコミット URL と一緒に必ず見せる (次回の push は該当記事が全て
   * 衝突扱いになるので、再取り込みで解消する)
   */
  dbError: string | null;
}

type PushedItem = { id: string; updatedAt: Date; blobSha: string };

/**
 * push 後の DB 更新。
 *
 * 1 文の `UPDATE … FROM (VALUES …)` で、組み立てた時点から `updatedAt` が変わっていない
 * 行だけ `dirty` を落とす (commit 中に編集された記事は、GitHub には古い内容が載ったので
 * dirty のまま残す)。334 行を `updateMany` で回すと往復が記事数ぶん要るので 1 文にする。
 * 素の SQL なので `@updatedAt` は動かない = push は編集ではないので `updatedAt` を進めない。
 *
 * - `pushed` (コミットに載せた): `githubSha` を新しい blob に、`lastPushedAt` を今にする。
 *   編集の有無に依らず全件 (GitHub 側の blob はどちらにせよ新しい方になった)
 * - `unchanged` (GitHub 側と同じだった): dirty だけ落とす。`githubSha` は一致しているので触らない
 *
 * `editedAt` (未 push の akashic 編集がある印) は **dirty を落とす行と同時に null に戻す**。
 * commit 中に編集された行は dirty と一緒に残す (その編集はまだ GitHub に無い)。
 *
 * Article は非保護テーブルなので素の prisma でよい。2 文は 1 トランザクションにまとめる。
 */
async function markPushed(pushed: PushedItem[], unchanged: PushedItem[]): Promise<void> {
  const values = (items: PushedItem[]) =>
    Prisma.join(items.map((i) => Prisma.sql`(${i.id}, ${i.updatedAt}::timestamp(3), ${i.blobSha})`));
  const now = new Date();
  const statements: Prisma.PrismaPromise<number>[] = [];
  if (pushed.length) {
    statements.push(prisma.$executeRaw`
      UPDATE "Article" AS a
      SET "githubSha" = v.sha,
          "lastPushedAt" = ${now},
          "dirty" = (a."updatedAt" <> v."updatedAt"),
          "editedAt" = CASE WHEN a."updatedAt" <> v."updatedAt" THEN a."editedAt" ELSE NULL END
      FROM (VALUES ${values(pushed)}) AS v(id, "updatedAt", sha)
      WHERE a.id = v.id`);
  }
  if (unchanged.length) {
    statements.push(prisma.$executeRaw`
      UPDATE "Article" AS a
      SET "dirty" = false, "editedAt" = NULL
      FROM (VALUES ${values(unchanged)}) AS v(id, "updatedAt", sha)
      WHERE a.id = v.id AND a."updatedAt" = v."updatedAt"`);
  }
  if (statements.length) await prisma.$transaction(statements);
}

/**
 * dirty な記事のうち push 可能なものを 1 コミットで GitHub に書き、DB を更新する。
 *
 * 1. GitHub の HEAD と tree を読み、dirty な記事を組み立て直して計画を作る (衝突・非 public は除外)
 * 2. 1 コミットで書く (ref 更新は non-force。1 の後にブランチが進んでいれば 422 で失敗する)
 * 3. push した記事の `githubSha` を新しい blob SHA に、`lastPushedAt` を今にする。
 *    `dirty = false` (と `editedAt = null`) は 1 の時点から `updatedAt` が変わっていない行だけ
 *    (`markPushed`)。GitHub 側と同じ内容だった記事 (`unchanged`) もここで dirty を落とす
 *
 * DB の更新は commit の **後** にまとめる (commit が 422 で失敗したら DB は何も変わらない)。
 * 2 が成功して 3 が失敗した場合は例外にせず `dbError` で返す。GitHub には載っているので、
 * 呼び出し側がコミット URL と一緒に見せる。次回の push は `githubSha` (古い) ≠ tree の SHA
 * (新しい) で衝突扱いになり、再取り込みで解消する (二重に書くことはない)。
 */
export async function pushDirtyArticles(subject?: string | null): Promise<PushArticlesResult> {
  if (!isGithubConfigured()) throw new Error("ARTICLES_GITHUB_TOKEN が設定されていません");

  const [rendered, { head, tree }] = await Promise.all([renderArticlesForPush({ dirty: true }), readUpstream()]);
  const plan = planPush(rendered, tree);
  const result: PushArticlesResult = {
    pushed: 0,
    unchanged: plan.unchanged.length,
    blocked: plan.blocked.length,
    conflicts: plan.conflicts.length,
    commit: null,
    dbError: null,
  };

  if (plan.ok.length) {
    const files = plan.ok.map((item) => ({ path: item.article.path, content: item.article.markdown }));
    result.commit = await commitFiles({
      head,
      message: buildCommitMessage(subject, files.map((f) => f.path)),
      files,
    });
    result.pushed = plan.ok.length;
  }

  try {
    await markPushed(
      plan.ok.map((item) => item.article),
      plan.unchanged.map((item) => item.article),
    );
  } catch (e) {
    if (!result.commit) throw e;
    result.dbError = e instanceof Error ? e.message : String(e);
  }
  return result;
}
