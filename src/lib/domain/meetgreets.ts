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
import { prisma, withClearance, withSession, type TransactionClient } from "@/lib/db";
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
import { fetchCollection, type FetchResult } from "./repo";
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

export interface ActingUser {
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
  /** 既にあるドシエを使う (未指定なら新しく作る) */
  dossierId?: string;
  /** 既にある X レポ収集を使う (未指定なら新しく作る) */
  repoCollectionId?: string;
}

export type ReportFetchOutcome =
  | { ok: true; result: FetchResult }
  | { ok: false; error: string };

/** 入力が不正なことを呼び出し元 (REST の 400) に伝える */
export class MeetGreetInputError extends Error {}

/**
 * 起点。ドシエと X レポ収集を用意して紐づける。
 *
 * **X の収集は走らせない。** 収集するかどうかは別の判断なので、X レポのステップから
 * 明示的に実行する (作成のたびに 40〜80 秒待たされ、X API の枠を使ってしまっていた #118)。
 *
 * `dossierId` / `repoCollectionId` を渡すと**既にあるものを使う**。`/meetgreets` を作る
 * 前から手で作っていたドシエ・収集を拾い直すのに使う。
 *
 * 作成は **1 トランザクション**にまとめる (途中で落ちたときに名前だけ同じドシエ・収集が
 * 孤児として残るのを防ぐ)。
 */
export async function createMeetGreet(
  user: ActingUser,
  input: CreateMeetGreetInput
): Promise<{ id: string }> {
  if (!isValidDateString(input.date)) {
    throw new MeetGreetInputError("date は暦に実在する YYYY-MM-DD で指定してください");
  }
  const classification = input.classification ?? "internal";
  assertClearance(user.clearance, classification);

  const naming = { ...input, single: input.single?.trim(), label: input.label?.trim() };
  const groups = reportTagGroups(input.format);

  const created = await withSession(user, async (tx) => {
    // 既にあるものを使う場合は、見えること・まだ他の回に使われていないことを確かめる
    if (input.dossierId) {
      const found = await tx.dossier.findUnique({
        where: { id: input.dossierId },
        select: { id: true, kind: true, meetGreet: { select: { id: true } } },
      });
      if (!found) throw new MeetGreetInputError("指定されたドシエが見つかりません");
      if (found.meetGreet) throw new MeetGreetInputError("そのドシエは別のミーグリに使われています");
      // 全員共有のクリップのプールを 1 回のミーグリに紐づけると、他人のクリップが素材として流れる (#41)
      if (found.kind === "clips") throw new MeetGreetInputError("クリップのプールはミーグリに使えません");
    }
    if (input.repoCollectionId) {
      const found = await tx.repoCollection.findUnique({
        where: { id: input.repoCollectionId },
        select: { id: true, meetGreet: { select: { id: true } } },
      });
      if (!found) throw new MeetGreetInputError("指定された X レポ収集が見つかりません");
      if (found.meetGreet) throw new MeetGreetInputError("その収集は別のミーグリに使われています");
    }

    const dossier = input.dossierId
      ? { id: input.dossierId }
      : await tx.dossier.create({
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
    const collection = input.repoCollectionId
      ? { id: input.repoCollectionId }
      : await tx.repoCollection.create({
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
      linkedExisting: !!(input.dossierId || input.repoCollectionId),
    },
  });

  return { id: created.meetGreetId };
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


/**
 * 記事の frontmatter に書いてあるドシエのスナップショットと、いまのドシエを突き合わせて
 * 「要反映」を判定する (sekai-nina-site の `pnpm check:dossiers` を akashic 側に持ってきたもの)。
 *
 * Article は非保護テーブルなので素の prisma でよい。
 */
async function loadNeedsSync(
  articleIds: string[],
  dossiers: Map<string, DossierBrief>,
  dossierIdByArticleId: Map<string, string>
): Promise<Set<string>> {
  if (articleIds.length === 0) return new Set();
  const rows = await prisma.article.findMany({
    where: { id: { in: articleIds } },
    select: { id: true, frontmatterExtra: true },
  });
  const stale = new Set<string>();
  for (const row of rows) {
    const extra = row.frontmatterExtra;
    const snap =
      extra && typeof extra === "object" && !Array.isArray(extra)
        ? (extra as { dossier?: { item_count?: unknown; updated_at?: unknown } }).dossier
        : undefined;
    const dossierId = dossierIdByArticleId.get(row.id);
    const current = dossierId ? dossiers.get(dossierId) : undefined;
    if (!current) continue;
    // スナップショットが無い記事は判定できないので「要反映」にしない (毎回出続けるのを避ける)
    if (!snap) continue;
    const countChanged =
      typeof snap.item_count === "number" && snap.item_count !== current.itemCount;
    const updatedChanged =
      typeof snap.updated_at === "string" && new Date(snap.updated_at) < current.updatedAt;
    if (countChanged || updatedChanged) stale.add(row.id);
  }
  return stale;
}

export async function listMeetGreets(user: ActingUser) {
  const loaded = await withSession(user, async (tx) => {
    const rows = await tx.meetGreet.findMany({
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      include: listInclude,
    });
    const [dossiers, counts] = await Promise.all([
      loadDossiers(tx, rows.map((r) => r.dossierId)),
      keepCounts(tx, rows.flatMap((r) => (r.repoCollectionId ? [r.repoCollectionId] : []))),
    ]);
    return { rows, dossiers, counts };
  });

  // Article は非保護テーブル。**トランザクションの外で引く**
  // (中で別の接続を取ると 15,000ms の枠を食い、プールも 2 本使う)
  const needsSync = await loadNeedsSync(
    loaded.rows.flatMap((r) => (r.articleId ? [r.articleId] : [])),
    loaded.dossiers,
    new Map(loaded.rows.flatMap((r) => (r.articleId ? [[r.articleId, r.dossierId] as const] : [])))
  );
  return loaded.rows.map((r) => ({
    ...r,
    dossier: loaded.dossiers.get(r.dossierId) ?? null,
    reports: r.repoCollectionId
      ? (loaded.counts.get(r.repoCollectionId) ?? { keep: 0, total: 0 })
      : null,
    /** ドシエが記事より新しい = 追記すべきものがある */
    needsSync: r.articleId ? needsSync.has(r.articleId) : false,
  }));
}

export type MeetGreetSummary = Awaited<ReturnType<typeof listMeetGreets>>[number];

export async function getMeetGreet(user: ActingUser, id: string) {
  const loaded = await withSession(user, async (tx) => {
    const row = await tx.meetGreet.findUnique({ where: { id }, include: listInclude });
    if (!row) return null;
    const [dossiers, counts] = await Promise.all([
      loadDossiers(tx, [row.dossierId]),
      keepCounts(tx, row.repoCollectionId ? [row.repoCollectionId] : []),
    ]);
    return { row, dossiers, counts };
  });
  if (!loaded) return null;

  const needsSync = await loadNeedsSync(
    loaded.row.articleId ? [loaded.row.articleId] : [],
    loaded.dossiers,
    new Map(loaded.row.articleId ? [[loaded.row.articleId, loaded.row.dossierId] as const] : [])
  );
  return {
    ...loaded.row,
    dossier: loaded.dossiers.get(loaded.row.dossierId) ?? null,
    reports: loaded.row.repoCollectionId
      ? (loaded.counts.get(loaded.row.repoCollectionId) ?? { keep: 0, total: 0 })
      : null,
    needsSync: loaded.row.articleId ? needsSync.has(loaded.row.articleId) : false,
  };
}

export type MeetGreetDetail = NonNullable<Awaited<ReturnType<typeof getMeetGreet>>>;

export interface UpdateMeetGreetInput {
  single?: string;
  label?: string;
  /** 会場の正式名称 (リアルの記事タイトルに出る)。空文字で消す */
  venue?: string;
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
        ...(input.venue !== undefined ? { venue: input.venue.trim() || null } : {}),
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
