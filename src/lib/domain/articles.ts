import { withClearance, prisma } from "@/lib/db";
import { assertClearance } from "@/lib/classification";
import { renderArticleMarkdown } from "@/lib/articles/frontmatter";
import { buildCommitMessage, planPush, type PushPlan, type RenderedArticle } from "@/lib/articles/push";
import { gitBlobSha } from "@/lib/github/blob";
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
  if (opts.onlyUnresolved) {
    where.sources = { some: { status: ArticleSourceStatus.unresolved } };
  }

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
          _count: { select: { sources: true } },
        },
      }),
      tx.article.count({ where }),
    ]);
    return { items, total, page, perPage };
  });
}

export async function getArticleByShortId(shortId: string, clearance: string) {
  return withClearance(clearance, (tx) =>
    tx.article.findUnique({
      where: { shortId },
      include: {
        sources: {
          orderBy: [{ sortOrder: "asc" }],
          include: {
            asset: {
              select: {
                id: true,
                title: true,
                kind: true,
                canonicalDate: true,
                thumbnailUrl: true,
              },
            },
          },
        },
      },
    }),
  );
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
      SET "githubSha" = v.sha, "lastPushedAt" = ${now}, "dirty" = (a."updatedAt" <> v."updatedAt")
      FROM (VALUES ${values(pushed)}) AS v(id, "updatedAt", sha)
      WHERE a.id = v.id`);
  }
  if (unchanged.length) {
    statements.push(prisma.$executeRaw`
      UPDATE "Article" AS a
      SET "dirty" = false
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
 *    `dirty = false` は 1 の時点から `updatedAt` が変わっていない行だけ (`markPushed`)。
 *    GitHub 側と同じ内容だった記事 (`unchanged`) もここで dirty を落とす
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
