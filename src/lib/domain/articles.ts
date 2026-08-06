import { withClearance } from "@/lib/db";
import { ArticleSourceStatus, type ArticleType, type Prisma } from "@prisma/client";

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
        orderBy: [{ publishedAt: "desc" }, { title: "asc" }],
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
