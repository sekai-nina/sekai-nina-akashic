/**
 * 記事の出典を記事の企画に写す (#337)。計画は `src/lib/article-workflow/dossier-sync.ts` (純粋関数)。
 *
 * **RLS をバイパスする接続 (`prismaInternal` / CLI の DIRECT_URL) で書く。** 既存の企画には所有者が
 * private にしたものがあり、出典を足した人 (API キーの bot を含む) の RLS では企画に書けないため。
 * 機密レベルは計画側で見る (企画より上の出典は足さない)。
 *
 * 出典を書いたトランザクションがコミットした**後**に呼ぶ。失敗しても出典の書き込みは失敗にしない
 * (`afterArticleSources*` がログに残す)。取りこぼしは `pnpm cli:sync-article-dossiers` で直す。
 *
 * - 企画の無い記事は企画を作る (`ensureArticleDossier` と同じ中身)。ミーグリ記事は回の企画にリンクする
 * - `Article.dossierId` / `Dossier.articleExclusions` は素の SQL で書き、`updatedAt` を進めない
 *   (編集画面の楽観ロックと、frontmatter の `dossier.updated_at` を動かさないため)
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { prismaInternal } from "@/lib/db";
import { isAboveClearance } from "@/lib/classification";
import {
  planDossierAdditions,
  planDossierRemovals,
  sourceKey,
  type RemovedSource,
  type SyncSource,
} from "@/lib/article-workflow/dossier-sync";

const SOURCE_SELECT = {
  assetId: true,
  url: true,
  refArticleId: true,
  label: true,
  excerpt: true,
  excerptType: true,
  excerptStart: true,
  excerptEnd: true,
  note: true,
  classification: true,
  asset: { select: { title: true, classification: true } },
} satisfies Prisma.ArticleSourceSelect;

const ITEM_SELECT = { id: true, assetId: true, externalUrl: true, excerpt: true, note: true, sortOrder: true } satisfies Prisma.DossierItemSelect;

export interface SyncResult {
  /** 企画を作った / ミーグリの企画にリンクした */
  dossier: "existing" | "created" | "linked" | "none";
  dossierId: string | null;
  added: number;
  skippedAbove: number;
  /** 企画が無く、所有者も決められなかった */
  noOwner?: boolean;
}

/** admin が 1 人だけならその人 (取り込みのように操作した人がいない経路の所有者) */
async function soleAdminId(db: PrismaClient): Promise<string | null> {
  const admins = await db.user.findMany({ where: { role: "admin" }, select: { id: true }, take: 2 });
  return admins.length === 1 ? admins[0].id : null;
}

async function ensureDossier(
  db: PrismaClient,
  article: { id: string; title: string; path: string; dossierId: string | null; meetGreet: { dossierId: string } | null },
  ownerId: string | null | undefined,
  apply: boolean
): Promise<Pick<SyncResult, "dossier" | "dossierId" | "noOwner">> {
  if (article.dossierId) return { dossier: "existing", dossierId: article.dossierId };
  if (article.meetGreet?.dossierId) {
    if (apply) {
      const linked = await db.$executeRaw`UPDATE "Article" SET "dossierId" = ${article.meetGreet.dossierId} WHERE "id" = ${article.id} AND "dossierId" IS NULL`;
      if (linked === 0) {
        // 先に別の経路がリンクした。そちらを使う
        const again = await db.article.findUnique({ where: { id: article.id }, select: { dossierId: true } });
        return { dossier: "existing", dossierId: again?.dossierId ?? null };
      }
    }
    return { dossier: "linked", dossierId: article.meetGreet.dossierId };
  }
  const owner = ownerId ?? (await soleAdminId(db));
  if (!owner) return { dossier: "none", dossierId: null, noOwner: true };
  if (!apply) return { dossier: "created", dossierId: null };

  const created = await db.dossier.create({
    data: {
      ownerId: owner,
      title: article.title || article.path,
      summary: `記事 ${article.path} の素材`,
      classification: "internal",
      viewMode: "clearance",
      editMode: "clearance",
    },
    select: { id: true },
  });
  const linked = await db.$executeRaw`UPDATE "Article" SET "dossierId" = ${created.id} WHERE "id" = ${article.id} AND "dossierId" IS NULL`;
  if (linked === 0) {
    // 同時に別の経路が作った。こちらは空なので消して、勝った側を使う
    await db.dossier.delete({ where: { id: created.id } });
    const again = await db.article.findUnique({ where: { id: article.id }, select: { dossierId: true } });
    return { dossier: "existing", dossierId: again?.dossierId ?? null };
  }
  // 画面の「素材の企画を作る」(`createDossier` + `ensureArticleDossier`) と同じ 2 行を残す
  await db.auditLog.createMany({
    data: [
      { actorId: owner, action: "dossier.create", targetType: "Dossier", targetId: created.id, metadata: { title: article.title || article.path, auto: true } },
      { actorId: owner, action: "article.dossier.link", targetType: "Article", targetId: article.id, metadata: { dossierId: created.id, created: true, auto: true } },
    ],
  });
  return { dossier: "created", dossierId: created.id };
}

/**
 * 記事の出典のうち企画に無いものを企画に足す。`apply: false` は書かずに計画だけ返す (CLI の下見)。
 *
 * `only` を渡すと、その出典 (`sourceKey`) だけを見る。**出典を足した経路は足したものだけを渡す。**
 * 全部を突き合わせると、人が企画から消したアイテムを (記事に出典が残っているせいで) 次の追加の
 * たびに復活させてしまう。全件の突き合わせは CLI で明示的に行う
 */
export async function syncArticleSourcesToDossier(
  db: PrismaClient,
  articleId: string,
  opts: { ownerId?: string | null; apply?: boolean; only?: string[] } = {}
): Promise<SyncResult> {
  const apply = opts.apply ?? true;
  const article = await db.article.findUnique({
    where: { id: articleId },
    select: {
      id: true,
      title: true,
      path: true,
      dossierId: true,
      meetGreet: { select: { dossierId: true } },
      sources: { orderBy: { sortOrder: "asc" }, select: SOURCE_SELECT },
    },
  });
  const none: SyncResult = { dossier: "none", dossierId: null, added: 0, skippedAbove: 0 };
  if (!article) return none;
  const only = opts.only ? new Set(opts.only) : null;
  const sources: SyncSource[] = only
    ? article.sources.filter((s) => {
        const key = sourceKey(s);
        return !!key && only.has(key);
      })
    : article.sources;
  // 素材になる出典が無ければ、企画を作るところから何もしない
  if (!sources.some((s) => sourceKey(s))) return none;

  const d = await ensureDossier(db, article, opts.ownerId, apply);
  if (!d.dossierId) {
    // 下見で「作る」場合は、空の企画に全部足す計画として数える
    const plan = d.dossier === "created" ? planDossierAdditions(sources, [], "internal") : null;
    return { ...d, added: plan?.add.length ?? 0, skippedAbove: plan?.skippedAbove.length ?? 0 };
  }
  const dossier = await db.dossier.findUnique({
    where: { id: d.dossierId },
    select: { classification: true, owner: { select: { clearance: true } }, items: { select: ITEM_SELECT } },
  });
  if (!dossier) return { ...none, dossierId: d.dossierId };

  // 所有者は自分の企画をクリアランスに関係なく見られるので、低い方に合わせる
  const limit = isAboveClearance(dossier.classification, dossier.owner.clearance)
    ? dossier.owner.clearance
    : dossier.classification;
  const plan = planDossierAdditions(sources, dossier.items, limit);
  if (apply && plan.add.length) {
    const base = Math.max(-1, ...dossier.items.map((i) => i.sortOrder)) + 1;
    await db.dossierItem.createMany({
      data: plan.add.map((a, i) => ({
        dossierId: d.dossierId!,
        kind: a.kind,
        assetId: a.assetId,
        externalUrl: a.externalUrl,
        caption: a.caption,
        excerpt: a.excerpt,
        excerptType: a.excerptType,
        excerptStart: a.excerptStart,
        excerptEnd: a.excerptEnd,
        note: a.note,
        sortOrder: base + i,
      })),
    });
  }
  return { ...d, added: plan.add.length, skippedAbove: plan.skippedAbove.length };
}

/**
 * 記事から外した出典に当たる企画のアイテムを片付ける。`removed` は外す前の行。
 * 外した後も同じアセット / URL の出典が残っていれば触らない
 */
export async function removeArticleSourcesFromDossier(
  db: PrismaClient,
  articleId: string,
  removed: RemovedSource[]
): Promise<{ deleted: number; excluded: number }> {
  if (!removed.length) return { deleted: 0, excluded: 0 };
  const article = await db.article.findUnique({
    where: { id: articleId },
    select: {
      dossierId: true,
      dossier: {
        select: {
          id: true,
          // 企画を共有する記事 (ミーグリの回など) のどれかがまだ出典にしていれば残す
          articles: { select: { sources: { select: { assetId: true, url: true, refArticleId: true } } } },
          articleExclusions: true,
          meetGreet: { select: { id: true, articleExclusions: true } },
          live: { select: { id: true, articleExclusions: true } },
          items: { select: ITEM_SELECT },
        },
      },
    },
  });
  const dossier = article?.dossier;
  if (!article || !dossier) return { deleted: 0, excluded: 0 };

  const plan = planDossierRemovals(removed, dossier.articles.flatMap((a) => a.sources), dossier.items);
  if (plan.deleteItemIds.length) {
    await db.dossierItem.deleteMany({ where: { dossierId: dossier.id, id: { in: plan.deleteItemIds } } });
  }
  let excluded = 0;
  if (plan.exclusionKeys.length) {
    // 除外キーの置き場は器 (MeetGreet / Live) があれば器、無ければ企画 (`storedExclusions` と同じ)
    const holder = dossier.meetGreet ?? dossier.live ?? dossier;
    const current = Array.isArray(holder.articleExclusions)
      ? holder.articleExclusions.filter((k): k is string => typeof k === "string")
      : [];
    const next = [...new Set([...current, ...plan.exclusionKeys])];
    excluded = next.length - current.length;
    if (excluded) {
      const json = JSON.stringify(next);
      if (dossier.meetGreet) await db.$executeRaw`UPDATE "MeetGreet" SET "articleExclusions" = ${json}::jsonb WHERE "id" = ${dossier.meetGreet.id}`;
      else if (dossier.live) await db.$executeRaw`UPDATE "Live" SET "articleExclusions" = ${json}::jsonb WHERE "id" = ${dossier.live.id}`;
      else await db.$executeRaw`UPDATE "Dossier" SET "articleExclusions" = ${json}::jsonb WHERE "id" = ${dossier.id}`;
    }
  }
  return { deleted: plan.deleteItemIds.length, excluded };
}

/** アプリの経路から呼ぶ版。出典の書き込みは済んでいるので、失敗してもログに残すだけ */
export async function afterArticleSourcesAdded(
  articleId: string,
  added: Pick<SyncSource, "assetId" | "url" | "refArticleId">[],
  ownerId: string | null | undefined
): Promise<void> {
  const only = added.map(sourceKey).filter((k): k is string => !!k);
  if (!only.length) return;
  try {
    await syncArticleSourcesToDossier(prismaInternal, articleId, { ownerId, only });
  } catch (e) {
    console.error(`記事 ${articleId} の出典を企画に写せませんでした (pnpm cli:sync-article-dossiers で直せます):`, e);
  }
}

export async function afterArticleSourcesRemoved(articleId: string, removed: RemovedSource[]): Promise<void> {
  try {
    await removeArticleSourcesFromDossier(prismaInternal, articleId, removed);
  } catch (e) {
    console.error(`記事 ${articleId} から外した出典を企画から片付けられませんでした:`, e);
  }
}
