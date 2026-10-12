/**
 * 本人ブログ → 言葉記事の進捗 (#206)。`/progress/blog` の裏側。
 *
 * ブログ 1 本 = 言葉記事 1 本 (`quote_blog` テンプレート、#170)。状態は 4 つ:
 * - **記事化済み**: 言葉記事 (`type: quote`、タイトル `ブログ「…」`) の出典がそのブログを指す。
 *   出典の assetId か URL で突き合わせる (取り込んだ既存記事は URL しか持たないことがある)
 * - **対象外**: 名言の無いブログを人が外した。`ArticleProgress` に持つ (#207 の共通テーブル)
 * - **作業中**: そのブログを含む `quote_blog` ドシエがあり、まだ記事が無い
 * - **未着手**: どれでもない
 *
 * `Article` は非保護テーブルなので素の `prisma`。`ArticleSource` / `ArticleProgress` / `Asset` は
 * `withClearance`、`Dossier` 系は所有者判定が要るので `withSession`。
 */

import type { ClearanceLevel, Prisma } from "@prisma/client";
import { prisma, withClearance, withSession } from "@/lib/db";
import { canEditDossier } from "@/lib/auth/dossier-permissions";
import { assertClearance } from "@/lib/classification";
import { normalizeSourceUrl } from "@/lib/article-workflow/render";
import { quoteBlogTitle } from "@/lib/article-workflow/templates/quote-blog";
import { MEETGREET_PERSON_NAME } from "@/lib/meetgreet/config";
import { countSiteQuotes, listQuotePassages, setPassageQuoted, type QuotePassage } from "@/lib/quotes/featured-passages";
import { toJstDateOnly } from "@/lib/utils";
import { patchArticle } from "./articles";
import { WorkflowInputError, type ActingUser } from "./article-workflow";
import { logAudit } from "./audit";

export class QuoteInputError extends WorkflowInputError {}

/** 本人ブログの本文アセット。メンバー全員のブログが `/diary/detail/` なので人物で絞る */
const OWN_BLOG_WHERE = {
  kind: "text",
  sourceRecords: { some: { url: { contains: "/diary/detail/" } } },
  entities: { some: { entity: { type: "person", canonicalName: MEETGREET_PERSON_NAME } } },
} satisfies Prisma.AssetWhereInput;

const PROGRESS_KEY = { materialKind: "blog", target: "quote_article" } as const;

export type BlogQuoteStatus = "done" | "excluded" | "in_progress" | "todo";

export interface BlogQuoteRow {
  assetId: string;
  url: string;
  /** `ブログ「X」` (言葉記事のタイトルと同じ形) */
  title: string;
  /** 投稿日 (JST) */
  date: string | null;
  status: BlogQuoteStatus;
  article: { shortId: string; title: string; quoteCount: number; dirty: boolean; draft: boolean } | null;
  /** 作業中のドシエ (記事化済みなら無い) */
  dossier: { id: string; excerptCount: number } | null;
  /** 対象外にした理由 */
  note: string;
}

interface OwnBlog {
  id: string;
  title: string;
  classification: ClearanceLevel;
  url: string;
  date: string | null;
}

function toOwnBlog(a: {
  id: string;
  title: string;
  classification: ClearanceLevel;
  canonicalDate: Date | null;
  sourceRecords: { url: string | null; publishedAt: Date | null }[];
}): OwnBlog | null {
  const src = a.sourceRecords.find((s) => s.url?.includes("/diary/detail/"));
  if (!src?.url) return null;
  return {
    id: a.id,
    title: a.title,
    classification: a.classification,
    url: normalizeSourceUrl(src.url),
    date: toJstDateOnly(src.publishedAt ?? a.canonicalDate),
  };
}

/** `…/diary/detail/66772?ima=0000` → `66772` */
function blogNo(url: string): string | null {
  return url.match(/\/diary\/detail\/(\d+)/)?.[1] ?? null;
}

const OWN_BLOG_SELECT = {
  id: true,
  title: true,
  classification: true,
  canonicalDate: true,
  sourceRecords: { select: { url: true, publishedAt: true } },
} satisfies Prisma.AssetSelect;

async function findOwnBlog(user: ActingUser, assetId: string): Promise<OwnBlog> {
  const asset = await withClearance(user.clearance, (tx) =>
    tx.asset.findFirst({ where: { id: assetId, ...OWN_BLOG_WHERE }, select: OWN_BLOG_SELECT })
  );
  const blog = asset && toOwnBlog(asset);
  if (!blog) throw new QuoteInputError("本人ブログが見つかりません");
  return blog;
}

export async function listBlogQuoteProgress(user: ActingUser): Promise<BlogQuoteRow[]> {
  const assets = await withClearance(user.clearance, (tx) =>
    tx.asset.findMany({ where: OWN_BLOG_WHERE, select: OWN_BLOG_SELECT })
  );
  const blogs = assets.flatMap((a) => toOwnBlog(a) ?? []);
  const ids = blogs.map((b) => b.id);

  const [sources, progress, items] = await Promise.all([
    withClearance(user.clearance, (tx) =>
      tx.articleSource.findMany({
        where: { article: { type: "quote", title: { startsWith: "ブログ「" } } },
        select: { assetId: true, url: true, articleId: true },
      })
    ),
    withClearance(user.clearance, (tx) =>
      tx.articleProgress.findMany({ where: PROGRESS_KEY, select: { materialKey: true, status: true, note: true } })
    ),
    withSession(user, (tx) =>
      tx.dossierItem.findMany({
        where: { assetId: { in: ids }, dossier: { articleTemplate: "quote_blog" } },
        select: { assetId: true, excerpt: true, dossierId: true, dossier: { select: { _count: { select: { articles: true } } } } },
      })
    ),
  ]);

  const articleIdByBlog = new Map<string, string>();
  const byAsset = new Map(blogs.map((b) => [b.id, b]));
  // URL は `?ima=0000` や http の揺れがあるのでブログの番号で突き合わせる
  const byBlogNo = new Map(blogs.flatMap((b) => (blogNo(b.url) ? [[blogNo(b.url)!, b] as const] : [])));
  for (const s of sources) {
    const no = s.url ? blogNo(s.url) : null;
    const blog = (s.assetId && byAsset.get(s.assetId)) || (no && byBlogNo.get(no));
    if (blog && !articleIdByBlog.has(blog.id)) articleIdByBlog.set(blog.id, s.articleId);
  }
  const articles = await prisma.article.findMany({
    where: { id: { in: [...new Set(articleIdByBlog.values())] } },
    select: { id: true, shortId: true, title: true, body: true, dirty: true, draft: true },
  });
  const articleById = new Map(articles.map((a) => [a.id, a]));

  const progressByUrl = new Map(progress.map((p) => [p.materialKey, p]));
  // 記事の無い quote_blog ドシエ。同じブログに 2 つあれば抜粋の多い方
  const dossierByBlog = new Map<string, { id: string; excerptCount: number }>();
  const excerpts = new Map<string, number>();
  for (const it of items) {
    if (!it.assetId || it.dossier._count.articles > 0) continue;
    const key = `${it.assetId}\u0000${it.dossierId}`;
    excerpts.set(key, (excerpts.get(key) ?? 0) + (it.excerpt ? 1 : 0));
  }
  for (const [key, n] of excerpts) {
    const [assetId, dossierId] = key.split("\u0000");
    const cur = dossierByBlog.get(assetId);
    if (!cur || n > cur.excerptCount) dossierByBlog.set(assetId, { id: dossierId, excerptCount: n });
  }

  const rows = blogs.map((b): BlogQuoteRow => {
    const a = articleById.get(articleIdByBlog.get(b.id) ?? "");
    const p = progressByUrl.get(b.url);
    const dossier = a ? null : (dossierByBlog.get(b.id) ?? null);
    const status: BlogQuoteStatus = a
      ? "done"
      : p?.status === "excluded"
        ? "excluded"
        : p?.status === "done"
          ? "done"
          : dossier
            ? "in_progress"
            : "todo";
    return {
      assetId: b.id,
      url: b.url,
      title: quoteBlogTitle(b.title),
      date: b.date,
      status,
      article: a
        ? { shortId: a.shortId, title: a.title, quoteCount: countSiteQuotes(a.body), dirty: a.dirty, draft: a.draft }
        : null,
      dossier,
      note: p?.note ?? "",
    };
  });
  rows.sort((x, y) => (y.date ?? "").localeCompare(x.date ?? "") || y.url.localeCompare(x.url));
  return rows;
}

/** 対象外にする / 戻す。行の機密レベルはブログに合わせる (ブログが見える人だけが触れる) */
export async function setBlogQuoteExcluded(
  user: ActingUser,
  assetId: string,
  excluded: boolean,
  note = ""
): Promise<void> {
  const blog = await findOwnBlog(user, assetId);
  assertClearance(user.clearance, blog.classification);
  const where = { materialKind_materialKey_target: { ...PROGRESS_KEY, materialKey: blog.url } };
  await withClearance(user.clearance, async (tx) => {
    if (excluded) {
      await tx.articleProgress.upsert({
        where,
        create: {
          ...PROGRESS_KEY,
          materialKey: blog.url,
          status: "excluded",
          note: note.trim(),
          classification: blog.classification,
          updatedById: user.id,
        },
        update: { status: "excluded", note: note.trim(), updatedById: user.id },
      });
    } else {
      await tx.articleProgress.deleteMany({ where: { ...PROGRESS_KEY, materialKey: blog.url } });
    }
  });
  await logAudit({
    actorId: user.id,
    action: excluded ? "article_progress.exclude" : "article_progress.include",
    targetType: "ArticleProgress",
    targetId: blog.url,
    metadata: { materialKind: "blog", target: "quote_article", assetId, note: note.trim() },
  });
}

/**
 * そのブログの言葉記事用ドシエを用意して id を返す。自分が編集できる作業中のドシエがあればそれを使う。
 * 新しく作るときはブログ本文を抜粋なしで 1 件入れておく (= 一覧の「作業中」の目印。
 * テンプレートは抜粋の無い項目を引用にしない)
 */
export async function startBlogQuoteDossier(user: ActingUser, assetId: string): Promise<string> {
  const blog = await findOwnBlog(user, assetId);
  assertClearance(user.clearance, blog.classification);

  const existing = await withSession(user, (tx) =>
    tx.dossier.findMany({
      where: { articleTemplate: "quote_blog", items: { some: { assetId } }, articles: { none: {} } },
      select: { id: true, ownerId: true, viewMode: true, editMode: true, classification: true },
      orderBy: { updatedAt: "desc" },
    })
  );
  const editable = existing.find((d) => canEditDossier(user, d));
  if (editable) return editable.id;

  // ドシエと目印の項目は 1 トランザクションで作る (項目だけ失敗すると「作業中」と分からない空のドシエが残り、
  // 押し直すたびに増える)
  const dossier = await withSession(user, async (tx) => {
    const d = await tx.dossier.create({
      data: {
        ownerId: user.id,
        title: `${quoteBlogTitle(blog.title)}の言葉記事`,
        summary: "本人ブログの名言 (言葉記事) の素材",
        classification: blog.classification,
        // ミーグリと同じく、作成者以外も抜粋を足せるようにする
        viewMode: "clearance",
        editMode: "clearance",
        articleTemplate: "quote_blog",
      },
      select: { id: true, title: true },
    });
    await tx.dossierItem.create({
      data: { dossierId: d.id, kind: "asset_ref", assetId, caption: blog.title, createdById: user.id, sortOrder: 0 },
    });
    return d;
  });
  await logAudit({
    actorId: user.id,
    action: "dossier.create",
    targetType: "Dossier",
    targetId: dossier.id,
    metadata: { title: dossier.title, articleTemplate: "quote_blog", assetId },
  });
  return dossier.id;
}

export interface QuoteArticlePassages {
  shortId: string;
  title: string;
  dirty: boolean;
  passages: QuotePassage[];
  quoteCount: number;
}

export async function getQuoteArticlePassages(shortId: string): Promise<QuoteArticlePassages | null> {
  const a = await prisma.article.findUnique({
    where: { shortId },
    select: { shortId: true, title: true, body: true, dirty: true, type: true },
  });
  if (!a || a.type !== "quote") return null;
  return {
    shortId: a.shortId,
    title: a.title,
    dirty: a.dirty,
    passages: listQuotePassages(a.body),
    quoteCount: countSiteQuotes(a.body),
  };
}

/**
 * 引用ブロック (= 抜粋) を名言集に載せる / 外す。記事は dirty になり、次の push でサイトに出る。
 * 1 ブロックの付け替えなので、読んだ直後の本文に当てれば他の編集を壊さない (`setMeetGreetReportFeatured` と同じ)
 */
export async function setQuotePassage(
  user: ActingUser,
  shortId: string,
  index: number,
  on: boolean,
  expectedText: string
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const article = await prisma.article.findUnique({
      where: { shortId },
      select: { body: true, updatedAt: true, type: true },
    });
    if (!article || article.type !== "quote") throw new QuoteInputError("言葉記事が見つかりません");
    const body = setPassageQuoted(article.body, index, on, expectedText);
    if (body === null) {
      throw new QuoteInputError("記事が変わっています。開き直してください (直らなければ記事の編集画面で直す)");
    }
    if (body === article.body) return;

    const res = await patchArticle(shortId, article.updatedAt, { body }, { id: user.id });
    if (res.ok) return;
    if (res.reason === "conflict") continue;
    throw new QuoteInputError(res.reason === "not_found" ? "言葉記事が見つかりません" : "本文を保存できませんでした");
  }
  throw new QuoteInputError("記事が同時に編集されています。開き直してください");
}
