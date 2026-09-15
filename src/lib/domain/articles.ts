import { withClearance, prisma } from "@/lib/db";
import { assertClearance } from "@/lib/classification";
import { buildFrontmatter, serializeArticle } from "@/lib/articles/frontmatter";
import {
  ArticleSourceStatus,
  ClearanceLevel,
  type ArticleType,
  type Prisma,
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

interface RenderedArticleBase {
  id: string;
  shortId: string;
  /** リポジトリ内のパス。push 先のファイル名 */
  path: string;
  dirty: boolean;
  githubSha: string | null;
}

/**
 * `renderArticleForPush` の戻り。`ok: false` のときは Markdown を組み立てない
 * (呼び出し側が確認を忘れても脚注の欠けた記事を push できないように)。
 */
export type RenderedArticle =
  | (RenderedArticleBase & {
      ok: true;
      /** 公開リポジトリに書き出す Markdown (frontmatter + 本文) */
      markdown: string;
    })
  | (RenderedArticleBase & {
      ok: false;
      /**
       * applied / unresolved なのに public でない行の脚注番号 (無ければ null)。
       * 本文が ^[n] で参照しているのに脚注が消える矛盾状態なので、push を拒否する
       */
      blockedSourceNos: (number | null)[];
    });

/**
 * 記事 1 本を push 用の Markdown に組み立てる。
 *
 * `PUSH_CLEARANCE` で読むので、RLS が非 public の ArticleSource を落とす。
 * それだけだと「applied なのに internal」の矛盾行が黙って消えて脚注が壊れた記事が
 * 公開されるため、矛盾の検出は **最高クリアランス (restricted) で脚注番号だけ**を
 * 引いて行う。`prismaInternal` で数えない理由: `DIRECT_URL` 未設定だと
 * `DATABASE_URL` に無言でフォールバックし、RLS で常に 0 件 = 「矛盾なし」に
 * なる (fail-open)。`withClearance` なら環境変数に依らず全行が見える。
 *
 * 読み出しと矛盾検出は別トランザクションなので、同時に `addAssetToArticle` が
 * 走ると別時点のスナップショットになる。push は人手の低頻度操作なので許容する
 * (#46 で commit 直前に再確認する)。
 */
export async function renderArticleForPush(shortId: string): Promise<RenderedArticle | null> {
  const article = await withClearance(PUSH_CLEARANCE, (tx) =>
    tx.article.findUnique({
      where: { shortId },
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
  if (!article) return null;

  const base: RenderedArticleBase = {
    id: article.id,
    shortId: article.shortId,
    path: article.path,
    dirty: article.dirty,
    githubSha: article.githubSha,
  };

  const blocked = await withClearance(ClearanceLevel.restricted, (tx) =>
    tx.articleSource.findMany({
      where: {
        articleId: article.id,
        status: { not: ArticleSourceStatus.pending },
        classification: { not: ClearanceLevel.public },
      },
      orderBy: [{ sortOrder: "asc" }],
      select: { sourceNo: true },
    }),
  );
  if (blocked.length) return { ...base, ok: false, blockedSourceNos: blocked.map((b) => b.sourceNo) };

  const built = buildFrontmatter(article);
  // PUSH_CLEARANCE が public なら RLS が先に落とすので、ここに非 public 行が
  // 残っているのは RLS が効いていない証拠。黙って進めない
  if (built.blocked.length) {
    throw new Error(`RLS を通過した非 public の ArticleSource があります (${article.path})`);
  }
  return { ...base, ok: true, markdown: serializeArticle(built.frontmatter, article.body) };
}
