/**
 * ライブ記事の作成ワークフロー (#148) のドメイン層。
 *
 * `Live` は 1 つのライブ (ツアー) につき 1 行で、素材置き場のドシエ・X レポの RepoCollection・
 * 生成した記事を束ね、公演 (`LivePerformance`) と披露曲 (`LiveSong` → `Song`) を持つ。
 * ミーグリ (meetgreets.ts) と同じ作りで、共有できる部分は article-workflow.ts にある。
 *
 * Live / LivePerformance / LiveSong は保護テーブル (Live の classification に従う RLS)。
 * ドシエは所有者判定 (app.user_id) が要るので読み書きとも withSession で行う。
 */

import type { ClearanceLevel, LiveSongRole, Prisma } from "@prisma/client";
import { withClearance, withSession, type TransactionClient } from "@/lib/db";
import { accessibleClassifications, assertClearance } from "@/lib/classification";
import {
  addDaysToDateString,
  formatJpDateRange,
  isValidDateString,
  jstDayEndExclusive,
  jstDayStart,
  normalizeText,
} from "@/lib/utils";
import { buildQuery } from "@/lib/twitter/x-search";
import {
  MATERIAL_WINDOW_DAYS,
  MAX_ARTICLE_CLEARANCE,
  MEETGREET_PERSON_NAME,
  REPORT_WINDOW_DAYS,
} from "@/lib/meetgreet/config";
import { classifyCandidates, type CandidateGroup } from "@/lib/meetgreet/candidates";
import {
  liveKeywords,
  liveReportTagGroups,
  MAX_PERFORMANCES,
  MAX_SONG_TITLE,
  MAX_SONGS_PER_LIST,
} from "@/lib/live/config";
import { normalizeSongTitle } from "@/lib/songs/normalize";
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

export type { ActingUser, DossierBrief };

/** 入力が不正なことを呼び出し元 (REST の 400) に伝える */
export class LiveInputError extends WorkflowInputError {}

/** X レポ収集の名前。ミーグリの `… 坂井新奈` に合わせる */
export function collectionNameFor(name: string): string {
  return `${name.trim()} ${MEETGREET_PERSON_NAME}`;
}

export interface PerformanceInput {
  /** 既存の行を残して更新するときの ID。無ければ新しく作る */
  id?: string;
  /** 公演日 (JST "YYYY-MM-DD") */
  date: string;
  venue?: string;
  label?: string;
  note?: string;
  /** 公演限定の追加曲 (ライブ共通の披露曲には入れない) */
  songs?: string[];
  /** センター曲 */
  centerSongs?: string[];
}

export interface SetlistInput {
  performances: PerformanceInput[];
  /** ライブ共通の披露曲 */
  commonSongs?: string[];
}

export interface CreateLiveInput extends SetlistInput {
  name: string;
  note?: string;
  classification?: ClearanceLevel;
  /** 既にある event エンティティを使う (未指定なら同名で find-or-create) */
  entityId?: string;
  /** 既にあるドシエを使う (未指定なら新しく作る) */
  dossierId?: string;
  /** 既にある X レポ収集を使う (未指定なら新しく作る) */
  repoCollectionId?: string;
}

function cleanSongs(list: readonly string[] | undefined, what: string): string[] {
  const out: string[] = [];
  // 同じリストの中の表記揺れ (「HEY!OHISAMA!」と「HEY！OHISAMA！」) も 1 曲にする
  const keys = new Set<string>();
  for (const raw of list ?? []) {
    const t = raw.replace(/\s+/g, " ").trim();
    if (!t) continue;
    if ([...t].length > MAX_SONG_TITLE) {
      throw new LiveInputError(`${what}の曲名が長すぎます (${MAX_SONG_TITLE} 文字まで): ${t.slice(0, 20)}…`);
    }
    const key = normalizeSongTitle(t);
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(t);
  }
  if (out.length > MAX_SONGS_PER_LIST) {
    throw new LiveInputError(`${what}が多すぎます (${MAX_SONGS_PER_LIST} 曲まで)`);
  }
  return out;
}

interface CleanPerformance {
  id?: string;
  date: string;
  venue: string;
  label: string;
  note: string;
  songs: string[];
  centerSongs: string[];
}

/** 公演の入力を検証して整える。順番は入力のまま (= sortOrder になる) */
function cleanSetlist(input: SetlistInput): { performances: CleanPerformance[]; commonSongs: string[] } {
  if (input.performances.length === 0) throw new LiveInputError("公演を 1 つ以上入れてください");
  if (input.performances.length > MAX_PERFORMANCES) {
    throw new LiveInputError(`公演が多すぎます (${MAX_PERFORMANCES} 件まで)`);
  }
  const performances = input.performances.map((p, i) => {
    if (!isValidDateString(p.date)) {
      throw new LiveInputError(`${i + 1} 行目の日付は暦に実在する YYYY-MM-DD で指定してください`);
    }
    return {
      ...(p.id ? { id: p.id } : {}),
      date: p.date,
      venue: (p.venue ?? "").trim(),
      label: (p.label ?? "").trim(),
      note: (p.note ?? "").trim(),
      songs: cleanSongs(p.songs, `${i + 1} 行目の追加曲`),
      centerSongs: cleanSongs(p.centerSongs, `${i + 1} 行目のセンター曲`),
    };
  });
  return { performances, commonSongs: cleanSongs(input.commonSongs, "共通披露曲") };
}

/**
 * 曲を find-or-create して、ライブの LiveSong を丸ごと入れ替える。
 * `Song` は非保護テーブルだが、同じトランザクションの中で触ってよい (RLS が無いだけ)。
 */
async function writeSetlist(
  tx: TransactionClient,
  liveId: string,
  performances: { id: string; songs: string[]; centerSongs: string[] }[],
  commonSongs: string[]
): Promise<void> {
  const titles = new Set<string>(commonSongs);
  for (const p of performances) {
    for (const t of p.songs) titles.add(t);
    for (const t of p.centerSongs) titles.add(t);
  }
  // 曲は 1 曲ずつ upsert しない (Prisma の upsert は 1 曲 3 クエリで、20 曲で 60 往復になる)。
  // **名寄せキー (normalizedTitle) で既存に寄せる** (#167: 「HEY!OHISAMA!」と「HEY！OHISAMA！」を
  // 別の曲にしない)。無いものだけまとめて作り (同時に同じ曲を作る競合は skipDuplicates が吸う)、引き直す
  const list = [...titles];
  const songIds = new Map<string, string>();
  if (list.length > 0) {
    const keyOf = new Map(list.map((t) => [t, normalizeSongTitle(t)] as const));
    const keys = [...new Set(keyOf.values())];
    const have = await tx.song.findMany({
      where: { normalizedTitle: { in: keys } },
      select: { id: true, normalizedTitle: true },
    });
    const idByKey = new Map(have.map((s) => [s.normalizedTitle, s.id]));
    const missing = list.filter((t) => !idByKey.has(keyOf.get(t)!));
    if (missing.length > 0) {
      // 同じキーに畳まれる表記が入力に 2 つあれば先のものを公式表記にする
      const seen = new Set<string>();
      const rows = missing.flatMap((title) => {
        const key = keyOf.get(title)!;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ title, normalizedTitle: key }];
      });
      await tx.song.createMany({ data: rows, skipDuplicates: true });
      const made = await tx.song.findMany({
        where: { normalizedTitle: { in: rows.map((r) => r.normalizedTitle) } },
        select: { id: true, normalizedTitle: true },
      });
      for (const s of made) idByKey.set(s.normalizedTitle, s.id);
    }
    for (const t of list) {
      const id = idByKey.get(keyOf.get(t)!);
      // 起きるとすれば normalizedTitle が title と食い違っている行がある (手で直した等) とき
      if (!id) throw new LiveInputError(`曲「${t}」を曲マスタに登録できませんでした`);
      songIds.set(t, id);
    }
  }

  await tx.liveSong.deleteMany({ where: { liveId } });

  const rows: Prisma.LiveSongCreateManyInput[] = [];
  const push = (performanceId: string | null, list: string[], role: LiveSongRole) => {
    list.forEach((title, i) => {
      rows.push({ liveId, performanceId, songId: songIds.get(title)!, role, sortOrder: i });
    });
  };
  push(null, commonSongs, "performed");
  for (const p of performances) {
    push(p.id, p.songs, "performed");
    push(p.id, p.centerSongs, "center");
  }
  if (rows.length > 0) await tx.liveSong.createMany({ data: rows });
}

/** 公演の初日と最終日 (収集の期間に使う) */
function dateRange(performances: { date: string }[]): { first: string; last: string } {
  const dates = performances.map((p) => p.date).sort();
  return { first: dates[0], last: dates[dates.length - 1] };
}

/** 一覧・詳細の見出しに出す公演期間 (「2025年9月20日〜11月21日」)。公演が無ければその旨 */
export function livePeriodLabel(live: { firstDate: string | null; lastDate: string | null }): string {
  if (!live.firstDate) return "公演未設定";
  return formatJpDateRange(live.firstDate, live.lastDate ?? live.firstDate);
}

/**
 * 起点。ドシエと X レポ収集を用意して紐づけ、公演と曲を入れる。
 *
 * **X の収集は走らせない** (ミーグリ #118 と同じ。X レポのステップから明示的に実行する)。
 * `dossierId` / `repoCollectionId` を渡すと既にあるものを使う。
 *
 * event エンティティは `entityId` を渡せばそれを使い、無ければライブ名で find-or-create する
 * (このエンティティが付いたアセットも素材候補に出す。過去のライブは既に event エンティティが
 * あるので、作るときに選べるようにしている)。
 *
 * 作成は **1 トランザクション** (途中で落ちたときに名前だけ同じドシエ・収集が孤児として残らない)。
 */
export async function createLive(user: ActingUser, input: CreateLiveInput): Promise<{ id: string }> {
  const name = input.name.trim();
  if (!name) throw new LiveInputError("ライブ名を入れてください");
  const classification = input.classification ?? "internal";
  assertClearance(user.clearance, classification);
  const setlist = cleanSetlist(input);
  const range = dateRange(setlist.performances);

  // **Entity は非保護で、名前が全員に見える。** 記事にできる上限 (internal) より上の機密の
  // ライブは、ライブ名をエンティティとして作らない (作るとライブ名が /entities に出て、
  // Live / ドシエ / 収集に付けた classification が意味を失う)。既にあるものを選ぶのは可
  const entityAllowed = new Set<string>(accessibleClassifications(MAX_ARTICLE_CLEARANCE)).has(classification);

  const created = await withSession(user, async (tx) => {
    // 既にあるものを使う場合は、見えること・まだ他の器に使われていないこと・プールでないことを確かめる
    try {
      await assertContainersFree(tx, input, "live");
    } catch (e) {
      if (e instanceof WorkflowInputError) throw new LiveInputError(e.message);
      throw e;
    }

    // Entity は非保護 (ポリシーが素通し) なので tx から触ってよい。place 以外なので clearance の絞りも要らない
    let entityId: string | null = null;
    if (input.entityId) {
      const found = await tx.entity.findUnique({
        where: { id: input.entityId },
        select: { id: true, type: true },
      });
      if (!found || found.type !== "event") throw new LiveInputError("指定されたイベントエンティティが見つかりません");
      entityId = found.id;
    } else if (entityAllowed) {
      const entity = await tx.entity.upsert({
        where: { type_canonicalName: { type: "event", canonicalName: name } },
        update: {},
        create: { type: "event", canonicalName: name, normalizedName: normalizeText(name) },
        select: { id: true },
      });
      entityId = entity.id;
    }

    const dossier = input.dossierId
      ? { id: input.dossierId }
      : await tx.dossier.create({
          data: {
            ownerId: user.id,
            title: name,
            summary: `${name}の記事素材`,
            classification,
            // 作成者以外も素材を足せるようにする (ドシエ既定の private では bot も触れない)
            viewMode: "clearance",
            editMode: "clearance",
            // 記事テンプレートは器が決める (#170)
            articleTemplate: "live",
          },
          select: { id: true },
        });
    const groups = liveReportTagGroups([]);
    const collection = input.repoCollectionId
      ? { id: input.repoCollectionId }
      : await tx.repoCollection.create({
          data: {
            name: collectionNameFor(name),
            groups: groups as unknown as Prisma.InputJsonValue,
            groupOp: "or",
            query: buildQuery(groups, "or", true, true, ""),
            startDate: range.first,
            endDate: addDaysToDateString(range.last, REPORT_WINDOW_DAYS),
            excludeRetweets: true,
            langJa: true,
            extra: "",
            // Live と同じ機密にする (既定の internal のままだと上位機密のライブ名が /repo に出る)
            classification,
          },
          select: { id: true },
        });
    const live = await tx.live.create({
      data: {
        name,
        note: (input.note ?? "").trim(),
        entityId,
        classification,
        dossierId: dossier.id,
        repoCollectionId: collection.id,
        createdById: user.id,
        performances: {
          create: setlist.performances.map((p, i) => ({
            date: p.date,
            venue: p.venue,
            label: p.label,
            note: p.note,
            sortOrder: i,
          })),
        },
      },
      select: { id: true, performances: { select: { id: true }, orderBy: { sortOrder: "asc" } } },
    });
    // **DB が振った ID を使う。** 入力の `id` は作成では受け付けない (REST のスキーマも弾く) が、
    // spread の順序で上書きされると他のライブの公演に曲が紐づくので、ここでも後勝ちにしておく
    await writeSetlist(
      tx,
      live.id,
      live.performances.map((row, i) => ({ ...setlist.performances[i], id: row.id })),
      setlist.commonSongs
    );
    return { liveId: live.id, dossierId: dossier.id, collectionId: collection.id, entityId };
  });

  await logAudit({
    actorId: user.id,
    action: "live.create",
    targetType: "Live",
    targetId: created.liveId,
    metadata: {
      name,
      performances: setlist.performances.length,
      dossierId: created.dossierId,
      collectionId: created.collectionId,
      entityId: created.entityId,
      linkedExisting: !!(input.dossierId || input.repoCollectionId || input.entityId),
    },
  });

  return { id: created.liveId };
}

const listInclude = {
  entity: { select: { id: true, canonicalName: true } },
  repoCollection: { select: { id: true, name: true, lastFetchedAt: true } },
  article: { select: { id: true, shortId: true, title: true, dirty: true, lastPushedAt: true } },
  createdBy: { select: { id: true, name: true } },
  performances: {
    select: { id: true, date: true, venue: true, label: true, note: true, sortOrder: true },
    orderBy: [{ sortOrder: "asc" }, { date: "asc" }],
  },
  songs: {
    select: { performanceId: true, role: true, sortOrder: true, song: { select: { title: true } } },
    orderBy: [{ sortOrder: "asc" }],
  },
} satisfies Prisma.LiveInclude;

type LiveRow = Prisma.LiveGetPayload<{ include: typeof listInclude }>;

export interface LivePerformanceView {
  id: string;
  date: string;
  venue: string;
  label: string;
  note: string;
  sortOrder: number;
  /** 公演限定の追加曲 */
  songs: string[];
  centerSongs: string[];
}

/** LiveSong の行を公演ごと / 共通に振り分ける */
function shapeSetlist(row: LiveRow): { performances: LivePerformanceView[]; commonSongs: string[] } {
  const common: string[] = [];
  const byPerf = new Map<string, { songs: string[]; centerSongs: string[] }>();
  for (const s of row.songs) {
    if (!s.performanceId) {
      if (s.role === "performed") common.push(s.song.title);
      continue;
    }
    const bucket = byPerf.get(s.performanceId) ?? { songs: [], centerSongs: [] };
    (s.role === "center" ? bucket.centerSongs : bucket.songs).push(s.song.title);
    byPerf.set(s.performanceId, bucket);
  }
  return {
    commonSongs: common,
    performances: row.performances.map((p) => ({
      ...p,
      songs: byPerf.get(p.id)?.songs ?? [],
      centerSongs: byPerf.get(p.id)?.centerSongs ?? [],
    })),
  };
}

function shapeRow(
  r: LiveRow,
  dossiers: Map<string, DossierBrief>,
  counts: Map<string, { keep: number; total: number }>,
  needsSync: Set<string>
) {
  const { performances, commonSongs } = shapeSetlist(r);
  const range = performances.length > 0 ? dateRange(performances) : null;
  // 曲の行は shape 済みのものだけ返す (生の LiveSong を外に出さない)
  const { songs: _, ...rest } = r;
  return {
    ...rest,
    performances,
    commonSongs,
    /** 初日 / 最終日 (公演が無ければ null) */
    firstDate: range?.first ?? null,
    lastDate: range?.last ?? null,
    dossier: dossiers.get(r.dossierId) ?? null,
    reports: r.repoCollectionId ? (counts.get(r.repoCollectionId) ?? { keep: 0, total: 0 }) : null,
    /** ドシエが記事より新しい = 追記すべきものがある */
    needsSync: r.articleId ? needsSync.has(r.articleId) : false,
  };
}

export async function listLives(user: ActingUser) {
  const loaded = await withSession(user, async (tx) => {
    const rows = await tx.live.findMany({
      orderBy: [{ createdAt: "desc" }],
      include: listInclude,
    });
    const [dossiers, counts] = await Promise.all([
      loadDossiers(tx, rows.map((r) => r.dossierId)),
      keepCounts(tx, rows.flatMap((r) => (r.repoCollectionId ? [r.repoCollectionId] : []))),
    ]);
    return { rows, dossiers, counts };
  });

  // Article は非保護テーブル。**トランザクションの外で引く**
  const needsSync = await loadNeedsSync(
    loaded.rows.flatMap((r) => (r.articleId ? [r.articleId] : [])),
    loaded.dossiers,
    new Map(loaded.rows.flatMap((r) => (r.articleId ? [[r.articleId, r.dossierId] as const] : [])))
  );
  const shaped = loaded.rows.map((r) => shapeRow(r, loaded.dossiers, loaded.counts, needsSync));
  // 初日の新しい順 (公演が無いものは末尾)。作成順だと過去のライブを後から入れたときに並びが崩れる
  shaped.sort((a, b) => (b.firstDate ?? "").localeCompare(a.firstDate ?? ""));
  return shaped;
}

export type LiveSummary = Awaited<ReturnType<typeof listLives>>[number];

export async function getLive(user: ActingUser, id: string) {
  const loaded = await withSession(user, async (tx) => {
    const row = await tx.live.findUnique({ where: { id }, include: listInclude });
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
  return shapeRow(loaded.row, loaded.dossiers, loaded.counts, needsSync);
}

export type LiveDetail = NonNullable<Awaited<ReturnType<typeof getLive>>>;

export interface UpdateLiveInput {
  name?: string;
  note?: string;
}

/**
 * 名前・補足の更新。作成済みのドシエ・収集・エンティティの名前は変えない
 * (それぞれの画面で変える。ミーグリの label と同じ扱い)
 */
export async function updateLive(user: ActingUser, id: string, input: UpdateLiveInput) {
  const fields = Object.keys(input).filter((k) => input[k as keyof UpdateLiveInput] !== undefined);
  if (fields.length === 0) throw new LiveInputError("更新項目がありません");
  const name = input.name?.trim();
  if (name !== undefined && !name) throw new LiveInputError("ライブ名を入れてください");

  const row = await withClearance(user.clearance, (tx) =>
    tx.live.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(input.note !== undefined ? { note: input.note.trim() } : {}),
      },
      select: { id: true, name: true, note: true },
    })
  );
  await logAudit({
    actorId: user.id,
    action: "live.update",
    targetType: "Live",
    targetId: id,
    metadata: { fields },
  });
  return row;
}

/**
 * 公演と曲を丸ごと入れ替える。
 *
 * `id` 付きの行は残して更新し (= 行の ID が変わらない)、入力に無い既存の行は消す。
 * 曲は毎回 LiveSong を作り直す (差分を取るより単純で、件数も高々数十)。
 */
export async function replaceSetlist(user: ActingUser, live: { id: string }, input: SetlistInput) {
  const setlist = cleanSetlist(input);

  const result = await withSession(user, async (tx) => {
    const found = await tx.live.findUnique({ where: { id: live.id }, select: { id: true } });
    if (!found) throw new LiveInputError("ライブが見つかりません");

    const existing = new Set(
      (await tx.livePerformance.findMany({ where: { liveId: live.id }, select: { id: true } })).map((p) => p.id)
    );
    // 渡された id は既存でも未知でも 2 回は受けない (未知の同じ id が 2 行に化けるのを防ぐ)
    const given = setlist.performances.flatMap((p) => (p.id ? [p.id] : []));
    if (new Set(given).size !== given.length) throw new LiveInputError("同じ公演が 2 回指定されています");
    const keep = given.filter((id) => existing.has(id));

    await tx.livePerformance.deleteMany({ where: { liveId: live.id, id: { notIn: keep } } });

    const written: { id: string; songs: string[]; centerSongs: string[] }[] = [];
    for (const [i, p] of setlist.performances.entries()) {
      const data = { date: p.date, venue: p.venue, label: p.label, note: p.note, sortOrder: i };
      const row =
        p.id && existing.has(p.id)
          ? await tx.livePerformance.update({ where: { id: p.id }, data, select: { id: true } })
          : await tx.livePerformance.create({ data: { ...data, liveId: live.id }, select: { id: true } });
      written.push({ id: row.id, songs: p.songs, centerSongs: p.centerSongs });
    }
    await writeSetlist(tx, live.id, written, setlist.commonSongs);
    return { performances: written.length, removed: existing.size - keep.length };
  });

  await logAudit({
    actorId: user.id,
    action: "live.setlist.replace",
    targetType: "Live",
    targetId: live.id,
    metadata: { ...result, commonSongs: setlist.commonSongs.length },
  });
  return result;
}

/**
 * Live の行だけを消す (公演・曲の紐づけは CASCADE)。自動で作ったドシエ / X レポ収集 /
 * event エンティティ・記事は残す (それぞれの画面から消せる。素材が入ったあとに巻き込んで消さない)。
 *
 * **消せるのは作成者か admin だけ** (ミーグリ #112 と同じ。公演・曲の手入力とスケッチ・
 * 除外リストがまとめて消えるので、誰でも消せる状態にしない)。
 */
export async function deleteLive(user: ActingUser, id: string) {
  const row = await withClearance(user.clearance, (tx) =>
    tx.live.findUnique({ where: { id }, select: { createdById: true } })
  );
  if (!row) throw new LiveInputError("見つかりません");
  if (user.role !== "admin" && row.createdById !== user.id) {
    throw new LiveInputError("このライブを消せるのは作った人か管理者だけです");
  }
  await withClearance(user.clearance, (tx) => tx.live.delete({ where: { id } }));
  await logAudit({
    actorId: user.id,
    action: "live.delete",
    targetType: "Live",
    targetId: id,
  });
}

// --- 素材候補 ---

/**
 * 各公演日〜 +MATERIAL_WINDOW_DAYS 日の本人 (坂井新奈) のアセットと、ライブの event エンティティが
 * 付いたアセットを候補にする。分類・初期チェックは純粋関数 classifyCandidates に任せ、
 * キーワードはライブ用 (ライブ名・会場名を含む)、トークの初期チェックはどれかの公演日〜翌日。
 */
export async function listMaterialCandidates(
  user: ActingUser,
  live: {
    name: string;
    dossierId: string;
    entityId: string | null;
    performances: { date: string; venue: string }[];
  }
): Promise<CandidateGroup[]> {
  // 公演日ごとの窓を作り、重なるものはまとめる (ツアーの連日公演で OR が増えすぎないように)
  const windows: { start: Date; end: Date }[] = [];
  for (const date of [...new Set(live.performances.map((p) => p.date))].sort()) {
    const start = jstDayStart(new Date(`${date}T00:00:00Z`));
    const end = jstDayEndExclusive(
      new Date(`${addDaysToDateString(date, MATERIAL_WINDOW_DAYS)}T00:00:00Z`)
    );
    const last = windows[windows.length - 1];
    if (last && start <= last.end) last.end = end > last.end ? end : last.end;
    else windows.push({ start, end });
  }
  // **日付窓とエンティティは別々に引く。** 最上位を OR にすると Postgres が Asset を全件
  // 走査する (実測 220〜650ms。ミーグリと同じ AND の形なら 40ms) ので、2 本に分けて id で畳む
  const wheres: Prisma.AssetWhereInput[] = [];
  if (windows.length > 0) {
    wheres.push({
      entities: { some: { entity: { type: "person", canonicalName: MEETGREET_PERSON_NAME } } },
      OR: windows.map((w) => ({ canonicalDate: { gte: w.start, lt: w.end } })),
    });
  }
  if (live.entityId) wheres.push({ entities: { some: { entityId: live.entityId } } });
  if (wheres.length === 0) return [];

  const dates = [...new Set(live.performances.map((p) => p.date))];
  const keywords = liveKeywords({ name: live.name, venues: live.performances.map((p) => p.venue) });

  return withSession(user, async (tx) => {
    const loaded = await Promise.all(wheres.map((where) => loadMaterialInputs(tx, where, live.dossierId)));
    const seen = new Set<string>();
    const inputs = loaded
      .flatMap((l) => l.inputs)
      .filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
    const staffTexts = new Map(loaded.flatMap((l) => [...l.staffTexts]));
    return classifyCandidates(inputs, {
      dates,
      keywords,
      inDossier: loaded[0].inDossier,
      staffTexts,
    });
  });
}

/**
 * チェックされたアセットをドシエに asset_ref で入れる (本体は `applyMaterialsToDossier`)。
 * ドシエが見えないときはこの器のエラーに読み替える (REST が 404 にする)。
 */
export async function applyMaterials(
  user: ActingUser,
  live: { id: string; dossierId: string },
  assetIds: string[]
): Promise<{ added: number; skipped: number }> {
  const ids = [...new Set(assetIds)];
  if (ids.length === 0) return { added: 0, skipped: 0 };

  let result: { added: number; skipped: number };
  try {
    result = await applyMaterialsToDossier(user, live.dossierId, ids);
  } catch (e) {
    if (e instanceof WorkflowInputError) throw new LiveInputError(e.message);
    throw e;
  }

  await logAudit({
    actorId: user.id,
    action: "live.materials.apply",
    targetType: "Live",
    targetId: live.id,
    metadata: { ...result, requested: ids.length, dossierId: live.dossierId },
  });
  return result;
}
