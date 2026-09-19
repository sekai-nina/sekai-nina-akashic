/**
 * ミーグリ記事の作成ワークフロー (#106) のドメイン層。
 *
 * `MeetGreet` は 1 回のミーグリにつき 1 行で、素材置き場のドシエ・X レポの
 * RepoCollection・生成した記事を束ねる。ドシエ / /repo / 記事の中身はそれぞれの
 * ドメイン層 (dossiers.ts / repo.ts / articles.ts) に任せ、ここは「作る・つなぐ・
 * 候補を出す・反映する」だけを持つ。
 *
 * MeetGreet は保護テーブル (classification の direct-classification RLS)。ドシエは
 * 所有者判定 (app.user_id) が要るので読み書きとも withSession で行う。
 */

import type { ClearanceLevel, MeetGreetFormat, Prisma } from "@prisma/client";
import { withClearance, withSession, type TransactionClient } from "@/lib/db";
import { assertClearance } from "@/lib/classification";
import { canEditDossier } from "@/lib/auth/dossier-permissions";
import {
  addDaysToDateString,
  formatJpDate,
  isValidDateString,
  jstDayStart,
  jstDayEndExclusive,
  MEETGREET_FORMAT_LABELS,
  MEETGREET_FORMAT_SHORT_LABELS,
} from "@/lib/utils";
import { buildQuery } from "@/lib/twitter/x-search";
import { proposeExcerpts, type ExcerptProposal } from "@/lib/meetgreet/excerpt";
import {
  generateSketches,
  loadAssetImage,
  loadStyleReference,
  SketchError,
  type GeneratedSketch,
} from "@/lib/meetgreet/sketch";
import { fetchCollection, type FetchResult } from "./repo";
import { addAssetItem } from "./dossiers";
import { logAudit } from "./audit";
import {
  MATERIAL_WINDOW_DAYS,
  MAX_REFERENCE_PHOTOS,
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
  return `${single}${input.label ?? ""}${meetGreetName(input)} ${MEETGREET_PERSON_NAME}`;
}

/** 画面の見出し・記事タイトルに使う「オンラインミーグリ」/「リアルミーグリ」 */
export function meetGreetName(input: { format: MeetGreetFormat }): string {
  return `${MEETGREET_FORMAT_LABELS[input.format]}ミーグリ`;
}

/** 一覧・詳細の見出し (`2026年8月1日 京都リアルミーグリ`) */
export function meetGreetTitle(input: MeetGreetNaming): string {
  return `${formatJpDate(input.date)} ${input.label ?? ""}${meetGreetName(input)}`;
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

/** 入力が不正なことを呼び出し元 (REST の 400) に伝える */
export class MeetGreetInputError extends Error {}

/**
 * 起点。ドシエ (誰でも編集できるよう clearance モード) と X レポ収集を作って紐づけ、
 * 収集を 1 回走らせる。
 *
 * 3 つの作成は **1 トランザクション**にまとめる (途中で落ちたときに名前だけ同じドシエ・
 * 収集が孤児として残るのを防ぐ)。X API と R2 への書き込みはトランザクションの外
 * (15,000ms の上限に当たるため)。X の失敗 (7 日より前の日付・レート制限等) は作成の
 * 失敗にしない (= 画面・REST から再収集できる)。
 */
export async function createMeetGreet(
  user: ActingUser,
  input: CreateMeetGreetInput
): Promise<{ id: string; fetch: ReportFetchOutcome }> {
  if (!isValidDateString(input.date)) {
    throw new MeetGreetInputError("date は暦に実在する YYYY-MM-DD で指定してください");
  }
  const classification = input.classification ?? "internal";
  assertClearance(user.clearance, classification);

  const naming = { ...input, single: input.single?.trim(), label: input.label?.trim() };
  const groups = reportTagGroups(input.format);

  const created = await withSession(user, async (tx) => {
    const dossier = await tx.dossier.create({
      data: {
        ownerId: user.id,
        title: dossierTitleFor(naming),
        summary: `${meetGreetTitle(naming)}の記事素材`,
        classification,
        // 作成者以外も素材を足せるようにする (ドシエ既定の private では bot も触れない)
        viewMode: "clearance",
        editMode: "clearance",
      },
      select: { id: true },
    });
    const collection = await tx.repoCollection.create({
      data: {
        name: collectionNameFor(naming),
        groups: groups as unknown as Prisma.InputJsonValue,
        groupOp: "or",
        query: buildQuery(groups, "or", true, true, ""),
        startDate: input.date,
        endDate: addDaysToDateString(input.date, REPORT_WINDOW_DAYS),
        excludeRetweets: true,
        langJa: true,
        extra: "",
        // MeetGreet と同じ機密にする (既定の internal のままだと上位機密の回の名前が /repo に出る)
        classification,
      },
      select: { id: true },
    });
    const meetGreet = await tx.meetGreet.create({
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
      select: { id: true },
    });
    return { meetGreetId: meetGreet.id, dossierId: dossier.id, collectionId: collection.id };
  });

  await logAudit({
    actorId: user.id,
    action: "meetgreet.create",
    targetType: "MeetGreet",
    targetId: created.meetGreetId,
    metadata: {
      date: input.date,
      format: input.format,
      dossierId: created.dossierId,
      collectionId: created.collectionId,
    },
  });

  const fetch = await safeFetch(created.collectionId, user.clearance);
  return { id: created.meetGreetId, fetch };
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
  repoCollection: { select: { id: true, name: true, lastFetchedAt: true } },
  article: { select: { id: true, shortId: true, title: true, dirty: true, lastPushedAt: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.MeetGreetInclude;

export interface DossierBrief {
  id: string;
  title: string;
  itemCount: number;
  updatedAt: Date;
}

/**
 * ドシエは **include せず別に引く**。
 *
 * `MeetGreet.dossier` は必須リレーションだが、Dossier の RLS は owner / viewMode で
 * 別に判定される。作成時は `viewMode: clearance` にしているものの、所有者があとから
 * private に戻したり機密を上げると、他の人には行が見えなくなる。必須リレーションを
 * include したままだと Prisma が "Field dossier is required to return data" を投げ、
 * **その 1 行ではなく一覧全体が 500 になる**。見えないものは null にして画面で伝える。
 */
async function loadDossiers(
  tx: TransactionClient,
  ids: string[]
): Promise<Map<string, DossierBrief>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.dossier.findMany({
    where: { id: { in: ids } },
    select: { id: true, title: true, updatedAt: true, _count: { select: { items: true } } },
  });
  return new Map(
    rows.map((d) => [d.id, { id: d.id, title: d.title, updatedAt: d.updatedAt, itemCount: d._count.items }])
  );
}

async function keepCounts(tx: TransactionClient, collectionIds: string[]) {
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
    const [dossiers, counts] = await Promise.all([
      loadDossiers(tx, rows.map((r) => r.dossierId)),
      keepCounts(tx, rows.flatMap((r) => (r.repoCollectionId ? [r.repoCollectionId] : []))),
    ]);
    return rows.map((r) => ({
      ...r,
      dossier: dossiers.get(r.dossierId) ?? null,
      reports: r.repoCollectionId ? (counts.get(r.repoCollectionId) ?? { keep: 0, total: 0 }) : null,
    }));
  });
}

export type MeetGreetSummary = Awaited<ReturnType<typeof listMeetGreets>>[number];

export async function getMeetGreet(user: ActingUser, id: string) {
  return withSession(user, async (tx) => {
    const row = await tx.meetGreet.findUnique({ where: { id }, include: listInclude });
    if (!row) return null;
    const [dossiers, counts] = await Promise.all([
      loadDossiers(tx, [row.dossierId]),
      keepCounts(tx, row.repoCollectionId ? [row.repoCollectionId] : []),
    ]);
    return {
      ...row,
      dossier: dossiers.get(row.dossierId) ?? null,
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
  const fields = Object.keys(input).filter((k) => input[k as keyof UpdateMeetGreetInput] !== undefined);
  if (fields.length === 0) throw new MeetGreetInputError("更新項目がありません");

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
    metadata: { fields },
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
  const end = jstDayEndExclusive(
    new Date(`${addDaysToDateString(meetGreet.date, MATERIAL_WINDOW_DAYS)}T00:00:00Z`)
  );

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
            orderBy: { createdAt: "asc" },
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
        inputs.map((i) => i.source?.url ?? "").filter((u) => u.includes("/diary/manager/"))
      ),
    ];
    const staffTexts = new Map<string, string>();
    if (staffUrls.length > 0) {
      const staff = await tx.asset.findMany({
        where: { kind: "text", sourceRecords: { some: { url: { in: staffUrls } } } },
        select: {
          // 対象の URL を持つ出典に限る (別の出典が先頭だと違う URL で引いてしまう)
          sourceRecords: { where: { url: { in: staffUrls } }, select: { url: true }, take: 1 },
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
 * チェックされたアセットをドシエに asset_ref で入れる。
 *
 * `addAssetItem` を 1 件ずつ呼ぶと 1 アセットあたり 2 トランザクション (権限チェック +
 * 追加) になり、30 件で数百クエリになる。権限は同じドシエに対して 1 回で足りるので、
 * ここでまとめて 1 トランザクションに収める。
 *
 * 既にドシエにあるアセットは飛ばす (`skipped`)。判定は listMaterialCandidates の
 * `inDossier` と同じく「そのアセットの DossierItem があるか」で、抜粋付きで入っている
 * ものも「ある」として扱う (画面でチェックできないものが REST から二重に入らないように)。
 */
export async function applyMaterials(
  user: ActingUser,
  meetGreet: { id: string; dossierId: string },
  assetIds: string[]
): Promise<{ added: number; skipped: number }> {
  const ids = [...new Set(assetIds)];
  if (ids.length === 0) return { added: 0, skipped: 0 };

  const result = await withSession(user, async (tx) => {
    const dossier = await tx.dossier.findUnique({
      where: { id: meetGreet.dossierId },
      select: { id: true, ownerId: true, classification: true, viewMode: true, editMode: true },
    });
    if (!dossier) throw new MeetGreetInputError("ドシエが見つかりません");
    if (!canEditDossier(user, dossier)) {
      throw new Error("Access denied: insufficient permission to edit this dossier");
    }

    const [assets, existing, last] = await Promise.all([
      tx.asset.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } }),
      tx.dossierItem.findMany({
        where: { dossierId: meetGreet.dossierId, assetId: { in: ids } },
        select: { assetId: true },
      }),
      tx.dossierItem.findFirst({
        where: { dossierId: meetGreet.dossierId },
        orderBy: { sortOrder: "desc" },
        select: { sortOrder: true },
      }),
    ]);
    const titles = new Map(assets.map((a) => [a.id, a.title]));
    const already = new Set(existing.flatMap((i) => (i.assetId ? [i.assetId] : [])));

    // クリアランス外・存在しない・既にあるものを飛ばす
    const toAdd = ids.filter((id) => titles.has(id) && !already.has(id));
    if (toAdd.length === 0) return { added: 0, skipped: ids.length };

    const base = (last?.sortOrder ?? -1) + 1;
    await tx.dossierItem.createMany({
      data: toAdd.map((assetId, i) => ({
        dossierId: meetGreet.dossierId,
        kind: "asset_ref" as const,
        assetId,
        caption: titles.get(assetId)!,
        sortOrder: base + i,
      })),
    });
    return { added: toAdd.length, skipped: ids.length - toAdd.length };
  });

  await logAudit({
    actorId: user.id,
    action: "meetgreet.materials.apply",
    targetType: "MeetGreet",
    targetId: meetGreet.id,
    metadata: { ...result, requested: ids.length, dossierId: meetGreet.dossierId },
  });
  return result;
}

/** X レポを再収集する (作成時に失敗したときや、翌日に投稿されたぶんを拾うとき) */
export async function refetchReports(
  user: ActingUser,
  meetGreet: { id: string; repoCollectionId: string | null }
): Promise<ReportFetchOutcome> {
  if (!meetGreet.repoCollectionId) return { ok: false, error: "X レポ収集が紐づいていません" };
  return safeFetch(meetGreet.repoCollectionId, user.clearance);
}

// --- 抜粋の提案 (#108) ---

export interface BlogExcerptProposals {
  assetId: string;
  title: string;
  url: string | null;
  proposals: ExcerptProposal[];
  /** 既にドシエに入っている抜粋 (start-end) */
  existing: { start: number; end: number }[];
}

/** 本人ブログか (ひなたぼっこ日記は本人の感想ではないので対象外) */
function isOwnBlogUrl(url: string | null | undefined): boolean {
  return !!url && url.includes("/diary/detail/");
}

/**
 * ドシエに入っている本人ブログの本文から「本人の感想」の抜粋案を出す。
 *
 * LLM に原文の部分文字列を返させ、`AssetText` 内の位置を確定したものだけを返す
 * (言い換えられていたら採らない)。**この時点では DB に書かない。** 人が選んでから
 * `applyExcerpts` で入れる。
 */
export async function proposeExcerptsForDossier(
  user: ActingUser,
  meetGreet: { date: string; format: MeetGreetFormat; dossierId: string }
): Promise<BlogExcerptProposals[]> {
  const blogs = await withSession(user, (tx) =>
    tx.dossierItem.findMany({
      where: { dossierId: meetGreet.dossierId, asset: { kind: "text" } },
      select: {
        excerpt: true,
        excerptStart: true,
        excerptEnd: true,
        asset: {
          select: {
            id: true,
            title: true,
            sourceRecords: { select: { url: true }, take: 1, orderBy: { createdAt: "asc" } },
            texts: {
              where: { textType: "body" },
              select: { content: true },
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
        },
      },
    })
  );

  // 同じアセットが抜粋ごとに複数 item を持つので、アセット単位にまとめる
  const byAsset = new Map<
    string,
    { title: string; url: string | null; content: string; existing: { start: number; end: number }[] }
  >();
  for (const item of blogs) {
    const a = item.asset;
    if (!a) continue;
    const url = a.sourceRecords[0]?.url ?? null;
    if (!isOwnBlogUrl(url)) continue;
    const content = a.texts[0]?.content;
    if (!content) continue;
    const entry = byAsset.get(a.id) ?? { title: a.title, url, content, existing: [] };
    if (item.excerptStart != null && item.excerptEnd != null) {
      entry.existing.push({ start: item.excerptStart, end: item.excerptEnd });
    }
    byAsset.set(a.id, entry);
  }

  const formatLabel = MEETGREET_FORMAT_LABELS[meetGreet.format];
  const results: BlogExcerptProposals[] = [];
  for (const [assetId, entry] of byAsset) {
    const proposals = await proposeExcerpts(entry.content, {
      date: meetGreet.date,
      formatLabel,
      blogTitle: entry.title,
    });
    // 既に同じ範囲が入っているものは出さない
    const fresh = proposals.filter(
      (p) => !entry.existing.some((e) => p.start < e.end && e.start < p.end)
    );
    results.push({ assetId, title: entry.title, url: entry.url, proposals: fresh, existing: entry.existing });
  }
  return results;
}

export interface ApplyExcerptInput {
  assetId: string;
  start: number;
  end: number;
}

/**
 * 選んだ抜粋をドシエに入れる。抜粋付きの item は 1 抜粋 = 1 item
 * (`addAssetItem` は excerpt があるとき必ず新しい item を作る)。
 * 本文は保存時に DB から切り出す (画面から渡された文字列を信じない)。
 */
export async function applyExcerpts(
  user: ActingUser,
  meetGreet: { id: string; dossierId: string },
  inputs: ApplyExcerptInput[]
): Promise<{ added: number; skipped: number }> {
  if (inputs.length === 0) return { added: 0, skipped: 0 };

  const assetIds = [...new Set(inputs.map((i) => i.assetId))];
  const [texts, existing] = await withSession(user, (tx) =>
    Promise.all([
      tx.assetText.findMany({
        where: { assetId: { in: assetIds }, textType: "body" },
        select: { assetId: true, content: true },
        orderBy: { createdAt: "asc" },
      }),
      tx.dossierItem.findMany({
        where: { dossierId: meetGreet.dossierId, assetId: { in: assetIds }, NOT: { excerptStart: null } },
        select: { assetId: true, excerptStart: true, excerptEnd: true },
      }),
    ])
  );
  const contentByAsset = new Map<string, string>();
  for (const t of texts) if (!contentByAsset.has(t.assetId)) contentByAsset.set(t.assetId, t.content);

  let added = 0;
  let skipped = 0;
  for (const input of inputs) {
    const content = contentByAsset.get(input.assetId);
    const valid =
      content !== undefined &&
      input.start >= 0 &&
      input.end > input.start &&
      input.end <= content.length;
    const overlaps = existing.some(
      (e) =>
        e.assetId === input.assetId &&
        e.excerptStart != null &&
        e.excerptEnd != null &&
        input.start < e.excerptEnd &&
        e.excerptStart < input.end
    );
    if (!valid || overlaps) {
      skipped++;
      continue;
    }
    await addAssetItem(user, meetGreet.dossierId, {
      assetId: input.assetId,
      excerpt: content.slice(input.start, input.end),
      excerptType: "body",
      excerptStart: input.start,
      excerptEnd: input.end,
    });
    added++;
  }

  await logAudit({
    actorId: user.id,
    action: "meetgreet.excerpts.apply",
    targetType: "MeetGreet",
    targetId: meetGreet.id,
    metadata: { added, skipped, dossierId: meetGreet.dossierId },
  });
  return { added, skipped };
}

// --- スケッチ (#108) ---

export interface SketchSourceAsset {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  canonicalDate: string | null;
}

/** スケッチの参照に使えるドシエ内の画像 */
export async function listSketchSources(
  user: ActingUser,
  meetGreet: { dossierId: string }
): Promise<SketchSourceAsset[]> {
  const items = await withSession(user, (tx) =>
    tx.dossierItem.findMany({
      where: { dossierId: meetGreet.dossierId, asset: { kind: "image" } },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        asset: { select: { id: true, title: true, thumbnailUrl: true, canonicalDate: true } },
      },
    })
  );
  const seen = new Set<string>();
  const out: SketchSourceAsset[] = [];
  for (const it of items) {
    const a = it.asset;
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    out.push({
      id: a.id,
      title: a.title,
      thumbnailUrl: a.thumbnailUrl,
      canonicalDate: a.canonicalDate ? a.canonicalDate.toISOString() : null,
    });
  }
  return out;
}

export interface GenerateSketchOptions {
  assetIds: string[];
  /** 作り直すときの元候補 (R2 key) */
  revisionOf?: string;
  revisionNote?: string;
}

/**
 * 候補を生成して `sketchCandidates` に積む。確定はしない。
 *
 * 画像のダウンロード・生成・R2 への保存は**トランザクションの外**で行う
 * (数十秒かかるので 15,000ms の上限に当たる)。
 */
export async function generateSketch(
  user: ActingUser,
  meetGreet: { id: string; dossierId: string; extraSketchPrompt: string; sketchCandidates: unknown },
  options: GenerateSketchOptions
): Promise<{ candidates: GeneratedSketch[] }> {
  const ids = [...new Set(options.assetIds)];
  if (ids.length === 0) throw new MeetGreetInputError("参照にする写真を選んでください");
  if (ids.length > MAX_REFERENCE_PHOTOS) {
    throw new MeetGreetInputError(`参照にできる写真は ${MAX_REFERENCE_PHOTOS} 枚までです`);
  }

  // ドシエに入っている画像だけを参照にする (任意のアセットを読ませない)
  const assets = await withSession(user, (tx) =>
    tx.asset.findMany({
      where: {
        id: { in: ids },
        kind: "image",
        dossierItems: { some: { dossierId: meetGreet.dossierId } },
      },
      select: {
        id: true,
        title: true,
        storageProvider: true,
        storageKey: true,
        thumbnailUrl: true,
        mimeType: true,
      },
    })
  );
  if (assets.length === 0) throw new MeetGreetInputError("ドシエにある画像を選んでください");

  const photos = (await Promise.all(assets.map((a) => loadAssetImage(a)))).filter(
    (p): p is NonNullable<typeof p> => p !== null
  );
  if (photos.length === 0) throw new SketchError("参照画像を取得できませんでした");

  let revisionOf: Awaited<ReturnType<typeof loadStyleReference>> | undefined;
  if (options.revisionOf) {
    const known = Array.isArray(meetGreet.sketchCandidates)
      ? (meetGreet.sketchCandidates as unknown[]).filter((k): k is string => typeof k === "string")
      : [];
    if (!known.includes(options.revisionOf)) {
      throw new MeetGreetInputError("作り直しの元にする候補が見つかりません");
    }
    revisionOf = await loadStyleReference(options.revisionOf);
  }

  const candidates = await generateSketches({
    meetGreetId: meetGreet.id,
    photos,
    extraPrompt: meetGreet.extraSketchPrompt,
    revisionOf,
    revisionNote: options.revisionNote,
  });

  await withClearance(user.clearance, async (tx) => {
    const current = await tx.meetGreet.findUnique({
      where: { id: meetGreet.id },
      select: { sketchCandidates: true },
    });
    const existing = Array.isArray(current?.sketchCandidates)
      ? (current!.sketchCandidates as unknown[]).filter((k): k is string => typeof k === "string")
      : [];
    await tx.meetGreet.update({
      where: { id: meetGreet.id },
      data: { sketchCandidates: [...existing, ...candidates.map((c) => c.key)] },
    });
  });

  await logAudit({
    actorId: user.id,
    action: "meetgreet.sketch.generate",
    targetType: "MeetGreet",
    targetId: meetGreet.id,
    metadata: {
      photos: photos.length,
      generated: candidates.length,
      revision: !!options.revisionOf,
    },
  });
  return { candidates };
}

/** 候補の 1 枚を確定する (記事のサムネになる) */
export async function selectSketch(
  user: ActingUser,
  meetGreet: { id: string; sketchCandidates: unknown },
  key: string
) {
  const known = Array.isArray(meetGreet.sketchCandidates)
    ? (meetGreet.sketchCandidates as unknown[]).filter((k): k is string => typeof k === "string")
    : [];
  if (!known.includes(key)) throw new MeetGreetInputError("その候補は見つかりません");

  await withClearance(user.clearance, (tx) =>
    tx.meetGreet.update({ where: { id: meetGreet.id }, data: { sketchKey: key } })
  );
  await logAudit({
    actorId: user.id,
    action: "meetgreet.sketch.select",
    targetType: "MeetGreet",
    targetId: meetGreet.id,
    metadata: { key },
  });
}
