import { withClearance, prisma } from "@/lib/db";
import { assertClearance } from "@/lib/classification";
import {
  ArticleSourceStatus,
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
