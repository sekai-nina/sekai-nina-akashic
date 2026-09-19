/**
 * 過去のドシエ・X コレクションを MeetGreet として取り込む (#118)。
 *
 * `/meetgreets` を作る前は、ミーグリごとにドシエを手で作って X レポも集めていた。
 * 35 件ぶんがそのまま残っているので、拾い直して画面に並べられるようにする。
 *
 * **X の収集は走らせない**（すでに集め終わっている）。
 */

import { prisma, withClearance, withSession } from "@/lib/db";
import { assertClearance } from "@/lib/classification";
import { parseDossierTitle, parseSingleFromCollectionName } from "@/lib/meetgreet/import";
import type { MeetGreetFormat } from "@prisma/client";
import { logAudit } from "./audit";
import { createMeetGreet, type ActingUser } from "./meetgreets";
import { NOT_CLIP_POOL } from "./dossiers";

export interface ImportCandidate {
  dossierId: string;
  dossierTitle: string;
  date: string;
  label: string;
  format: MeetGreetFormat;
  itemCount: number;
  single: string;
  collection: { id: string; name: string; tweetCount: number; keepCount: number } | null;
}

/**
 * まだ MeetGreet になっていない、ミーグリ形式のドシエを挙げる。
 * 同じ日付の X レポ収集があれば一緒に紐づける候補として出す。
 */
export async function listImportCandidates(user: ActingUser): Promise<ImportCandidate[]> {
  return withSession(user, async (tx) => {
    const [dossiers, collections, counts] = await Promise.all([
      tx.dossier.findMany({
        // 既に取り込み済みのものは出さない (何度実行してもよい)。クリップのプールも対象外 (#41)
        where: { meetGreet: null, ...NOT_CLIP_POOL },
        select: { id: true, title: true, _count: { select: { items: true } } },
      }),
      tx.repoCollection.findMany({
        where: { meetGreet: null, startDate: { not: null } },
        select: { id: true, name: true, startDate: true },
      }),
      tx.repoTweet.groupBy({ by: ["collectionId", "status"], _count: { _all: true } }),
    ]);

    const tweetCounts = new Map<string, { total: number; keep: number }>();
    for (const g of counts) {
      const c = tweetCounts.get(g.collectionId) ?? { total: 0, keep: 0 };
      c.total += g._count._all;
      if (g.status === "keep") c.keep += g._count._all;
      tweetCounts.set(g.collectionId, c);
    }

    const byDate = new Map<string, (typeof collections)[number]>();
    for (const c of collections) if (c.startDate && !byDate.has(c.startDate)) byDate.set(c.startDate, c);

    const out: ImportCandidate[] = [];
    for (const d of dossiers) {
      const parsed = parseDossierTitle(d.title);
      if (!parsed) continue;
      const col = byDate.get(parsed.date) ?? null;
      const n = col ? (tweetCounts.get(col.id) ?? { total: 0, keep: 0 }) : null;
      out.push({
        dossierId: d.id,
        dossierTitle: d.title,
        date: parsed.date,
        label: parsed.label,
        format: parsed.format,
        itemCount: d._count.items,
        // シングル名は収集の名前にしか入っていない
        single: col ? parseSingleFromCollectionName(col.name) : "",
        collection: col
          ? { id: col.id, name: col.name, tweetCount: n!.total, keepCount: n!.keep }
          : null,
      });
    }
    return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  });
}

export interface LinkableDossier {
  id: string;
  title: string;
  itemCount: number;
}

/**
 * まだミーグリに使われていないドシエ。作成時に「既存のドシエから作る」で選ぶ。
 * 命名が手作業時代の形でなくても選べるよう、解析はせずそのまま出す。
 */
export async function listLinkableDossiers(user: ActingUser): Promise<LinkableDossier[]> {
  const rows = await withSession(user, (tx) =>
    tx.dossier.findMany({
      // クリップのプールは選ばせない (#41)。記事の素材ドシエも回の素材ではないので除く
      where: { meetGreet: null, articles: { none: {} }, ...NOT_CLIP_POOL },
      orderBy: [{ title: "desc" }],
      take: 200,
      select: { id: true, title: true, _count: { select: { items: true } } },
    })
  );
  return rows.map((d) => ({ id: d.id, title: d.title, itemCount: d._count.items }));
}

/**
 * 選んだ候補を MeetGreet にする。
 * 途中で 1 件失敗しても残りは続ける (35 件まとめて取り込むので、1 件のために全部やり直さない)。
 */
export async function importMeetGreets(
  user: ActingUser,
  dossierIds: string[]
): Promise<{ imported: number; failed: { dossierTitle: string; error: string }[] }> {
  const wanted = new Set(dossierIds);
  if (wanted.size === 0) return { imported: 0, failed: [] };

  const candidates = (await listImportCandidates(user)).filter((c) => wanted.has(c.dossierId));

  let imported = 0;
  const failed: { dossierTitle: string; error: string }[] = [];
  for (const c of candidates) {
    try {
      // ドシエ自体の機密に合わせる (取り込みで機密を下げない)
      const classification = await withSession(user, (tx) =>
        tx.dossier
          .findUnique({ where: { id: c.dossierId }, select: { classification: true } })
          .then((d) => d?.classification ?? "internal")
      );
      assertClearance(user.clearance, classification);

      const { reused } = await createMeetGreet(user, {
        date: c.date,
        format: c.format,
        single: c.single,
        label: c.label,
        classification,
        dossierId: c.dossierId,
        ...(c.collection ? { repoCollectionId: c.collection.id } : {}),
      });
      // **再利用は「取り込んだ」と数えない (#112)。** 同じ (日付/形式/呼び分け) に
      // 解釈される候補が 2 つあると、2 件目は紐づかないまま成功に見えてしまう
      // (候補一覧にも出続ける)。指定したドシエと食い違えば createMeetGreet が投げるが、
      // 同じドシエを 2 回渡したケースはここで拾う
      if (reused) {
        failed.push({
          dossierTitle: c.dossierTitle,
          error: "同じ日・形式・呼び分けの回が既にあります (呼び分けを変えてから取り込んでください)",
        });
      } else {
        imported++;
      }
    } catch (e) {
      failed.push({
        dossierTitle: c.dossierTitle,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  await logAudit({
    actorId: user.id,
    action: "meetgreet.import",
    targetType: "MeetGreet",
    targetId: "-",
    metadata: { requested: wanted.size, imported, failed: failed.length },
  });
  return { imported, failed };
}

// --- 既存記事の紐づけ (#109) ---

export interface ArticleLinkCandidate {
  meetGreetId: string;
  date: string;
  dossierTitle: string;
  articleId: string;
  articleTitle: string;
  articleShortId: string;
}

/**
 * まだ記事が紐づいていない MeetGreet のうち、公開記事の frontmatter が
 * 同じドシエを指しているものを挙げる。
 *
 * `/meetgreets` を作る前に書いた記事は `dossier.id` を frontmatter に持っているので、
 * それで機械的に突き合わせられる。
 */
export async function listArticleLinkCandidates(user: ActingUser): Promise<ArticleLinkCandidate[]> {
  const meetGreets = await withSession(user, (tx) =>
    tx.meetGreet.findMany({
      where: { articleId: null },
      select: { id: true, date: true, dossierId: true, dossier: { select: { title: true } } },
    })
  );
  if (meetGreets.length === 0) return [];

  // Article は非保護テーブルなので素の prisma でよいが、**MeetGreet を条件に混ぜない**
  // (保護テーブルなので app.clearance 無しのサブクエリは 0 行になり、
  // `meetGreet: null` が常に真になって絞り込みが効かない)。
  // 既に使われている記事は withSession で引いた ID で外す
  const linkedArticleIds = new Set(
    (
      await withSession(user, (tx) =>
        tx.meetGreet.findMany({
          where: { articleId: { not: null } },
          select: { articleId: true },
        })
      )
    ).flatMap((m) => (m.articleId ? [m.articleId] : []))
  );
  const articles = (
    await prisma.article.findMany({
      where: { type: "event" },
      select: { id: true, title: true, shortId: true, frontmatterExtra: true },
    })
  ).filter((a) => !linkedArticleIds.has(a.id));
  const byDossier = new Map<string, (typeof articles)[number]>();
  for (const a of articles) {
    const extra = a.frontmatterExtra;
    const id =
      extra && typeof extra === "object" && !Array.isArray(extra)
        ? (extra as { dossier?: { id?: unknown } }).dossier?.id
        : undefined;
    if (typeof id === "string" && !byDossier.has(id)) byDossier.set(id, a);
  }

  const out: ArticleLinkCandidate[] = [];
  for (const mg of meetGreets) {
    const art = byDossier.get(mg.dossierId);
    if (!art) continue;
    out.push({
      meetGreetId: mg.id,
      date: mg.date,
      dossierTitle: mg.dossier?.title ?? "",
      articleId: art.id,
      articleTitle: art.title,
      articleShortId: art.shortId,
    });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** 選んだ候補の記事を MeetGreet に紐づける */
export async function linkArticles(
  user: ActingUser,
  meetGreetIds: string[]
): Promise<{ linked: number; failed: { title: string; error: string }[] }> {
  const wanted = new Set(meetGreetIds);
  if (wanted.size === 0) return { linked: 0, failed: [] };

  const candidates = (await listArticleLinkCandidates(user)).filter((c) => wanted.has(c.meetGreetId));
  let linked = 0;
  const failed: { title: string; error: string }[] = [];
  for (const c of candidates) {
    try {
      await withClearance(user.clearance, async (tx) => {
        const mg = await tx.meetGreet.update({
          where: { id: c.meetGreetId },
          data: { articleId: c.articleId },
          select: { dossierId: true },
        });
        // 記事の素材ドシエ (#41) は回のドシエ。updatedAt を進めないよう素の SQL で書く
        await tx.$executeRaw`UPDATE "Article" SET "dossierId" = ${mg.dossierId} WHERE "id" = ${c.articleId} AND "dossierId" IS NULL`;
      });
      linked++;
    } catch (e) {
      failed.push({ title: c.articleTitle, error: e instanceof Error ? e.message : String(e) });
    }
  }

  await logAudit({
    actorId: user.id,
    action: "meetgreet.article.link",
    targetType: "MeetGreet",
    targetId: "-",
    metadata: { requested: wanted.size, linked, failed: failed.length },
  });
  return { linked, failed };
}
