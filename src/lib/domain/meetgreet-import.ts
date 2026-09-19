/**
 * 過去のドシエ・X コレクションを MeetGreet として取り込む (#118)。
 *
 * `/meetgreets` を作る前は、ミーグリごとにドシエを手で作って X レポも集めていた。
 * 35 件ぶんがそのまま残っているので、拾い直して画面に並べられるようにする。
 *
 * **X の収集は走らせない**（すでに集め終わっている）。
 */

import { withSession } from "@/lib/db";
import { assertClearance } from "@/lib/classification";
import { parseDossierTitle, parseSingleFromCollectionName } from "@/lib/meetgreet/import";
import type { MeetGreetFormat } from "@prisma/client";
import { logAudit } from "./audit";
import { createMeetGreet, type ActingUser } from "./meetgreets";

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
        // 既に取り込み済みのものは出さない (何度実行してもよい)
        where: { meetGreet: null },
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
      where: { meetGreet: null },
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

      await createMeetGreet(user, {
        date: c.date,
        format: c.format,
        single: c.single,
        label: c.label,
        classification,
        dossierId: c.dossierId,
        ...(c.collection ? { repoCollectionId: c.collection.id } : {}),
      });
      imported++;
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
