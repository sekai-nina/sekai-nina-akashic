/**
 * ミーグリ記事の作成ワークフロー (#106) のドメイン層。
 *
 * `MeetGreet` は 1 回のミーグリにつき 1 行で、素材置き場のドシエ・X レポの
 * RepoCollection・生成した記事を束ねる。ドシエ / /repo / 記事の中身はそれぞれの
 * ドメイン層 (dossiers.ts / repo.ts / articles.ts) に任せ、ここは「作る・つなぐ・
 * 候補を出す・反映する」だけを持つ。
 *
 * MeetGreet は保護テーブル (classification の direct-classification RLS)。ドシエを
 * include する読みは所有者判定 (app.user_id) が要るので withSession で行う。
 */

import type { ClearanceLevel, MeetGreetFormat, Prisma } from "@prisma/client";
import { withClearance, withSession } from "@/lib/db";
import { assertClearance } from "@/lib/classification";
import { jstDayStart, jstDayEndExclusive, MEETGREET_FORMAT_LABELS, MEETGREET_FORMAT_SHORT_LABELS } from "@/lib/utils";
import { createDossier, addAssetItem } from "./dossiers";
import { createCollection, fetchCollection, type FetchResult } from "./repo";
import { logAudit } from "./audit";
import {
  MATERIAL_WINDOW_DAYS,
  MEETGREET_PERSON_NAME,
  REPORT_WINDOW_DAYS,
  reportTagGroups,
} from "@/lib/meetgreet/config";
import {
  classifyCandidates,
  type CandidateAssetInput,
  type CandidateGroup,
} from "@/lib/meetgreet/candidates";

interface ActingUser {
  id: string;
  role: string;
  clearance: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" に日数を足す (UTC 計算で十分。暦日文字列どうしの演算なので TZ は関係ない) */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "2026-08-01" → "2026年8月1日" */
export function formatJpDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${y}年${m}月${d}日`;
}

export interface MeetGreetNaming {
  date: string;
  format: MeetGreetFormat;
  single?: string;
  label?: string;
}

/** ドシエ名。既存の手作業の命名 (`2026-08-01 京都リアミ` / `2026-08-09 通常オンミ`) に合わせる */
export function dossierTitleFor(input: MeetGreetNaming): string {
  return `${input.date} ${input.label ?? ""}${MEETGREET_FORMAT_SHORT_LABELS[input.format]}`;
}

/** X レポ収集の名前。既存 (`17th『Kind of love』通常オンラインミーグリ 2026年8月9日 坂井新奈`) に合わせる */
export function collectionNameFor(input: MeetGreetNaming): string {
  const single = input.single?.trim() ? `${input.single.trim()} ` : "";
  return `${single}${input.label ?? ""}${MEETGREET_FORMAT_LABELS[input.format]}ミーグリ ${formatJpDate(input.date)} ${MEETGREET_PERSON_NAME}`;
}

export interface CreateMeetGreetInput {
  date: string;
  format: MeetGreetFormat;
  single?: string;
  label?: string;
  classification?: ClearanceLevel;
}

export type ReportFetchOutcome =
  | { ok: true; result: FetchResult }
  | { ok: false; error: string };

/**
 * 起点。ドシエ (誰でも編集できるよう clearance モード) と X レポ収集を自動で作って紐づけ、
 * 収集を 1 回走らせる。X API の失敗 (7 日より前の日付・レート制限等) は作成の失敗にしない
 * (= 画面から再収集できる)。
 */
export async function createMeetGreet(
  user: ActingUser,
  input: CreateMeetGreetInput
): Promise<{ id: string; fetch: ReportFetchOutcome }> {
  if (!DATE_RE.test(input.date) || Number.isNaN(Date.parse(`${input.date}T00:00:00Z`))) {
    throw new Error("date は YYYY-MM-DD で指定してください");
  }
  const classification = input.classification ?? "internal";
  assertClearance(user.clearance, classification);

  const naming = { ...input, single: input.single?.trim(), label: input.label?.trim() };

  const dossier = await createDossier(user, {
    title: dossierTitleFor(naming),
    summary: `${formatJpDate(input.date)} ${MEETGREET_FORMAT_LABELS[input.format]}ミート＆グリートの記事素材`,
    classification,
    viewMode: "clearance",
    editMode: "clearance",
  });

  const collection = await createCollection(
    {
      name: collectionNameFor(naming),
      groups: reportTagGroups(input.format),
      groupOp: "or",
      startDate: input.date,
      endDate: addDays(input.date, REPORT_WINDOW_DAYS),
      excludeRetweets: true,
      langJa: true,
      extra: "",
    },
    user.clearance
  );

  const meetGreet = await withClearance(user.clearance, (tx) =>
    tx.meetGreet.create({
      data: {
        date: input.date,
        format: input.format,
        single: naming.single ?? "",
        label: naming.label ?? "",
        classification,
        dossierId: dossier.id,
        repoCollectionId: collection.id,
        createdById: user.id,
      },
    })
  );

  await logAudit({
    actorId: user.id,
    action: "meetgreet.create",
    targetType: "MeetGreet",
    targetId: meetGreet.id,
    metadata: { date: input.date, format: input.format, dossierId: dossier.id, collectionId: collection.id },
  });

  const fetch = await safeFetch(collection.id, user.clearance);
  return { id: meetGreet.id, fetch };
}

async function safeFetch(collectionId: string, clearance: string): Promise<ReportFetchOutcome> {
  try {
    const result = await fetchCollection(collectionId, clearance);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const listInclude = {
  dossier: { select: { id: true, title: true, updatedAt: true, _count: { select: { items: true } } } },
  repoCollection: { select: { id: true, name: true, lastFetchedAt: true } },
  article: { select: { id: true, shortId: true, title: true, dirty: true, lastPushedAt: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.MeetGreetInclude;

async function keepCounts(
  tx: Parameters<Parameters<typeof withSession>[1]>[0],
  collectionIds: string[]
) {
  if (collectionIds.length === 0) return new Map<string, { keep: number; total: number }>();
  const grouped = await tx.repoTweet.groupBy({
    by: ["collectionId", "status"],
    where: { collectionId: { in: collectionIds } },
    _count: { _all: true },
  });
  const counts = new Map<string, { keep: number; total: number }>();
  for (const g of grouped) {
    const c = counts.get(g.collectionId) ?? { keep: 0, total: 0 };
    c.total += g._count._all;
    if (g.status === "keep") c.keep += g._count._all;
    counts.set(g.collectionId, c);
  }
  return counts;
}

export async function listMeetGreets(user: ActingUser) {
  return withSession(user, async (tx) => {
    const rows = await tx.meetGreet.findMany({
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      include: listInclude,
    });
    const counts = await keepCounts(
      tx,
      rows.flatMap((r) => (r.repoCollectionId ? [r.repoCollectionId] : []))
    );
    return rows.map((r) => ({
      ...r,
      reports: r.repoCollectionId ? (counts.get(r.repoCollectionId) ?? { keep: 0, total: 0 }) : null,
    }));
  });
}

export type MeetGreetSummary = Awaited<ReturnType<typeof listMeetGreets>>[number];

export async function getMeetGreet(user: ActingUser, id: string) {
  return withSession(user, async (tx) => {
    const row = await tx.meetGreet.findUnique({ where: { id }, include: listInclude });
    if (!row) return null;
    const counts = await keepCounts(tx, row.repoCollectionId ? [row.repoCollectionId] : []);
    return {
      ...row,
      reports: row.repoCollectionId ? (counts.get(row.repoCollectionId) ?? { keep: 0, total: 0 }) : null,
    };
  });
}

export type MeetGreetDetail = NonNullable<Awaited<ReturnType<typeof getMeetGreet>>>;

export interface UpdateMeetGreetInput {
  single?: string;
  label?: string;
  extraSketchPrompt?: string;
}

export async function updateMeetGreet(user: ActingUser, id: string, input: UpdateMeetGreetInput) {
  const row = await withClearance(user.clearance, (tx) =>
    tx.meetGreet.update({
      where: { id },
      data: {
        ...(input.single !== undefined ? { single: input.single.trim() } : {}),
        ...(input.label !== undefined ? { label: input.label.trim() } : {}),
        ...(input.extraSketchPrompt !== undefined ? { extraSketchPrompt: input.extraSketchPrompt } : {}),
      },
    })
  );
  await logAudit({
    actorId: user.id,
    action: "meetgreet.update",
    targetType: "MeetGreet",
    targetId: id,
    metadata: { fields: Object.keys(input) },
  });
  return row;
}

/**
 * MeetGreet の行だけを消す。自動で作ったドシエ / X レポ収集は残す
 * (= それぞれの画面から消せる。素材が入ったあとに巻き込んで消さない)。
 */
export async function deleteMeetGreet(user: ActingUser, id: string) {
  await withClearance(user.clearance, (tx) => tx.meetGreet.delete({ where: { id } }));
  await logAudit({
    actorId: user.id,
    action: "meetgreet.delete",
    targetType: "MeetGreet",
    targetId: id,
  });
}

// --- 素材候補 ---

/**
 * 当日〜 +MATERIAL_WINDOW_DAYS 日の、本人 (坂井新奈) が付いたアセットを候補にする。
 * 分類・初期チェックは純粋関数 classifyCandidates に任せる。
 *
 * 運営ブログ (ひなたぼっこ日記) の本文 text には本人の人物エンティティが付かないので、
 * 候補に出た運営ブログの URL について本文だけ別に引いてキーワード判定に使う。
 */
export async function listMaterialCandidates(
  user: ActingUser,
  meetGreet: { date: string; dossierId: string }
): Promise<CandidateGroup[]> {
  const start = jstDayStart(new Date(`${meetGreet.date}T00:00:00Z`));
  const end = jstDayEndExclusive(new Date(`${addDays(meetGreet.date, MATERIAL_WINDOW_DAYS)}T00:00:00Z`));

  return withSession(user, async (tx) => {
    const [assets, inDossier] = await Promise.all([
      tx.asset.findMany({
        where: {
          canonicalDate: { gte: start, lt: end },
          entities: { some: { entity: { type: "person", canonicalName: MEETGREET_PERSON_NAME } } },
        },
        orderBy: { canonicalDate: "asc" },
        select: {
          id: true,
          kind: true,
          title: true,
          canonicalDate: true,
          thumbnailUrl: true,
          sourceRecords: { select: { url: true, title: true }, take: 1, orderBy: { createdAt: "asc" } },
          texts: {
            where: { textType: { in: ["body", "message_body"] } },
            select: { content: true },
            take: 1,
          },
          entities: {
            where: { entity: { type: "tag", canonicalName: "トーク" } },
            select: { entityId: true },
            take: 1,
          },
        },
      }),
      tx.dossierItem.findMany({
        where: { dossierId: meetGreet.dossierId, assetId: { not: null } },
        select: { assetId: true },
      }),
    ]);

    const inputs: CandidateAssetInput[] = assets.map((a) => ({
      id: a.id,
      kind: a.kind,
      title: a.title,
      canonicalDate: a.canonicalDate,
      thumbnailUrl: a.thumbnailUrl,
      source: a.sourceRecords[0] ?? null,
      text: a.texts[0]?.content ?? null,
      hasTalkTag: a.entities.length > 0,
    }));

    // 運営ブログの本文 (本人タグ無し) を URL ごとに引く
    const staffUrls = [
      ...new Set(
        inputs
          .map((i) => i.source?.url ?? "")
          .filter((u) => u.includes("/diary/manager/"))
      ),
    ];
    const staffTexts = new Map<string, string>();
    if (staffUrls.length > 0) {
      const staff = await tx.asset.findMany({
        where: { kind: "text", sourceRecords: { some: { url: { in: staffUrls } } } },
        select: {
          sourceRecords: { select: { url: true }, take: 1 },
          texts: { where: { textType: "body" }, select: { content: true }, take: 1 },
        },
      });
      for (const s of staff) {
        const url = s.sourceRecords[0]?.url;
        const content = s.texts[0]?.content;
        if (url && content) staffTexts.set(url, content);
      }
    }

    return classifyCandidates(inputs, {
      date: meetGreet.date,
      inDossier: new Set(inDossier.flatMap((i) => (i.assetId ? [i.assetId] : []))),
      staffTexts,
    });
  });
}

/**
 * チェックされたアセットをドシエに asset_ref で入れる。既にドシエにあるものは飛ばす
 * (addAssetItem 自体も抜粋無しの参照を冪等に扱うが、ここで数えないと「2 件追加」が
 * 2 回目の押下でも出る)。caption は画面の「ドシエに追加」と同じくアセットのタイトル。
 */
export async function applyMaterials(
  user: ActingUser,
  meetGreet: { id: string; dossierId: string },
  assetIds: string[]
): Promise<{ added: number; skipped: number }> {
  const ids = [...new Set(assetIds)];
  if (ids.length === 0) return { added: 0, skipped: 0 };

  const [assets, existing] = await withSession(user, (tx) =>
    Promise.all([
      tx.asset.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } }),
      tx.dossierItem.findMany({
        where: { dossierId: meetGreet.dossierId, assetId: { in: ids }, excerpt: "" },
        select: { assetId: true },
      }),
    ])
  );
  const titles = new Map(assets.map((a) => [a.id, a.title]));
  const already = new Set(existing.map((i) => i.assetId));

  let added = 0;
  let skipped = 0;
  for (const assetId of ids) {
    const title = titles.get(assetId);
    if (title === undefined || already.has(assetId)) {
      skipped++; // クリアランス外・存在しない・既にある
      continue;
    }
    await addAssetItem(user, meetGreet.dossierId, { assetId, caption: title });
    added++;
  }

  await logAudit({
    actorId: user.id,
    action: "meetgreet.materials.apply",
    targetType: "MeetGreet",
    targetId: meetGreet.id,
    metadata: { added, skipped, requested: ids.length },
  });
  return { added, skipped };
}

/** X レポを再収集する (作成時に失敗したときや、翌日に投稿されたぶんを拾うとき) */
export async function refetchReports(
  user: ActingUser,
  meetGreet: { id: string; repoCollectionId: string | null }
): Promise<ReportFetchOutcome> {
  if (!meetGreet.repoCollectionId) return { ok: false, error: "X レポ収集が紐づいていません" };
  return safeFetch(meetGreet.repoCollectionId, user.clearance);
}
