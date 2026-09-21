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

import { Prisma } from "@prisma/client";
import type { ClearanceLevel, MeetGreetFormat } from "@prisma/client";
import { withClearance, withSession } from "@/lib/db";
import { assertClearance } from "@/lib/classification";
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
  applyMaterialsToDossier,
  assertContainersFree,
  keepCounts,
  loadDossiers,
  loadMaterialInputs,
  loadNeedsSync,
  WorkflowInputError,
  type ActingUser,
  type DossierBrief,
} from "./article-workflow";
import {
  MATERIAL_WINDOW_DAYS,
  MEETGREET_PERSON_NAME,
  REPORT_WINDOW_DAYS,
  reportTagGroups,
} from "@/lib/meetgreet/config";
import { classifyCandidates, type CandidateGroup } from "@/lib/meetgreet/candidates";

export type { ActingUser, DossierBrief };

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
export class MeetGreetInputError extends WorkflowInputError {}

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
): Promise<{ id: string; reused: boolean }> {
  if (!isValidDateString(input.date)) {
    throw new MeetGreetInputError("date は暦に実在する YYYY-MM-DD で指定してください");
  }
  const classification = input.classification ?? "internal";
  assertClearance(user.clearance, classification);

  const naming = { ...input, single: input.single?.trim(), label: input.label?.trim() };
  const groups = reportTagGroups(input.format);
  const label = naming.label ?? "";

  // **同じ回が既にあればそれを返す (#112)。** 作成は X の収集込みで数十秒かかることがあり、
  // bot がタイムアウトして再送するとドシエ・収集が二重にできていた。
  // 競合で擦り抜けた分は `@@unique([date, format, label])` が止め、下の catch で拾う
  const existing = await findSameMeetGreet(user, input.date, input.format, label);
  if (existing) return { id: assertReusable(existing, input), reused: true };

  let created: { id: string };
  try {
    created = await createInTransaction(user, input, naming, groups, classification);
  } catch (e) {
    // 同時に 2 本走ったとき。@@unique が止めてくれるので、既にできたほうを返す
    if (isDuplicateMeetGreet(e)) {
      const again = await findSameMeetGreet(user, input.date, input.format, label);
      if (again) return { id: assertReusable(again, input), reused: true };
      // **見えない回とぶつかった。** 自分より上の機密で同じ回が作られている。
      // Prisma の文面をそのまま出すと「その日に何かある」と分かってしまうし、
      // 500 のままだと bot が永久に再送するので、入力の問題として返す
      throw new MeetGreetInputError(
        "この日付・形式・呼び分けでは作成できません。呼び分け (label) を変えてください"
      );
    }
    throw e;
  }
  return { id: created.id, reused: false };
}

async function createInTransaction(
  user: ActingUser,
  input: CreateMeetGreetInput,
  naming: MeetGreetNaming,
  groups: ReturnType<typeof reportTagGroups>,
  classification: ClearanceLevel
): Promise<{ id: string }> {
  const created = await withSession(user, async (tx) => {
    // 既にあるものを使う場合は、見えること・まだ他の回 (ミーグリ / ライブ) に使われていないこと・
    // クリップのプールでないこと (#41) を確かめる
    try {
      await assertContainersFree(tx, input, "meetgreet");
    } catch (e) {
      if (e instanceof WorkflowInputError) throw new MeetGreetInputError(e.message);
      throw e;
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
            // 記事テンプレートは器が決める (#170)
            articleTemplate: "meetgreet",
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

  // label は `@@unique([date, format, label])` の一部。同じ日の別の回とぶつかると
  // P2002 が上がるので、生の Prisma エラーを画面 / REST に出さない (#112)
  let row;
  try {
    row = await withClearance(user.clearance, (tx) =>
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
  } catch (e) {
    if (isDuplicateMeetGreet(e)) {
      throw new MeetGreetInputError("その呼び分けは同じ日の別の回で使われています");
    }
    throw e;
  }
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
 * MeetGreet の行だけを消す。**自動で作ったドシエ / X レポ収集・記事は残す**
 * (= それぞれの画面から消せる。素材が入ったあとに巻き込んで消さない)。
 *
 * **消せるのは作成者か admin だけ (#112)。** ドシエの削除が所有者だけ
 * (`canManageDossier`) なのに、ミーグリは誰でも消せて非対称だった。
 * 消すとスケッチ・切り抜き枠・記事の紐づけ・除外リストがまとめて消える。
 */
export async function deleteMeetGreet(user: ActingUser, id: string) {
  const row = await withClearance(user.clearance, (tx) =>
    tx.meetGreet.findUnique({ where: { id }, select: { createdById: true } })
  );
  if (!row) throw new MeetGreetInputError("見つかりません");
  if (user.role !== "admin" && row.createdById !== user.id) {
    throw new MeetGreetInputError("この回を消せるのは作った人か管理者だけです");
  }
  await withClearance(user.clearance, (tx) => tx.meetGreet.delete({ where: { id } }));
  await logAudit({
    actorId: user.id,
    action: "meetgreet.delete",
    targetType: "MeetGreet",
    targetId: id,
  });
}

// --- 素材候補 ---

interface SameMeetGreet {
  id: string;
  dossierId: string;
  repoCollectionId: string | null;
}

/** `@@unique([date, format, label])` に当たったか (他の unique と区別する) */
function isDuplicateMeetGreet(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = e.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? "")];
  return fields.some((f) => f.includes("date")) || fields.some((f) => f.includes("date_format_label"));
}

/** 同じ (date, format, label) の回を探す。見えない (クリアランス) なら null */
async function findSameMeetGreet(
  user: ActingUser,
  date: string,
  format: MeetGreetFormat,
  label: string
): Promise<SameMeetGreet | null> {
  const row = await withClearance(user.clearance, (tx) =>
    tx.meetGreet.findUnique({
      where: { date_format_label: { date, format, label } },
      select: { id: true, dossierId: true, repoCollectionId: true },
    })
  );
  return row ?? null;
}

/**
 * 既にある回を再利用してよいか。
 *
 * **「紐づけたいドシエ / 収集」を指定してきたのに別物を返さない。** 再送の取りこぼしを
 * 拾うのが目的なので、何も指定していない (= 同じ要求の再送) ときだけ黙って返す。
 * 指定があるのに食い違うなら、取り込みが「成功したのに紐づいていない」状態になるので断る
 * (一括取り込みはここで失敗として数える)。
 */
function assertReusable(existing: SameMeetGreet, input: CreateMeetGreetInput): string {
  if (input.dossierId && input.dossierId !== existing.dossierId) {
    throw new MeetGreetInputError(
      "同じ日・形式・呼び分けの回が既にあります (別のドシエが紐づいています)。呼び分け (label) を変えてください"
    );
  }
  if (input.repoCollectionId && input.repoCollectionId !== existing.repoCollectionId) {
    throw new MeetGreetInputError(
      "同じ日・形式・呼び分けの回が既にあります (別の X 収集が紐づいています)。呼び分け (label) を変えてください"
    );
  }
  return existing.id;
}

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
    const { inputs, inDossier, staffTexts } = await loadMaterialInputs(
      tx,
      {
        canonicalDate: { gte: start, lt: end },
        entities: { some: { entity: { type: "person", canonicalName: MEETGREET_PERSON_NAME } } },
      },
      meetGreet.dossierId
    );
    return classifyCandidates(inputs, { date: meetGreet.date, inDossier, staffTexts });
  });
}

/**
 * チェックされたアセットをドシエに asset_ref で入れる (本体は `applyMaterialsToDossier`)。
 * ドシエが見えないときはこの器のエラーに読み替える (REST が 404 にする)。
 */
export async function applyMaterials(
  user: ActingUser,
  meetGreet: { id: string; dossierId: string },
  assetIds: string[]
): Promise<{ added: number; skipped: number }> {
  const ids = [...new Set(assetIds)];
  if (ids.length === 0) return { added: 0, skipped: 0 };

  let result: { added: number; skipped: number };
  try {
    result = await applyMaterialsToDossier(user, meetGreet.dossierId, ids);
  } catch (e) {
    if (e instanceof WorkflowInputError) throw new MeetGreetInputError(e.message);
    throw e;
  }

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
