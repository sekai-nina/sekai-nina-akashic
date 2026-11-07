import { unstable_cache } from "next/cache";
import { DossierKind, Prisma, type AssetKind, type DataSource } from "@prisma/client";
import { withClearance, withSession, type TransactionClient } from "@/lib/db";
import { groupClipRows } from "@/lib/clips/group";
import { adjacentTalkDays, isTalkDayKey, nextUnfinishedTalkDay, talkSpeaker, talkThread, type TalkDayScope } from "@/lib/clip-progress/talk-day";
import { jstDayString } from "@/lib/utils";
import { NINA_ENTITY_ID } from "@/lib/nina";
import { DERIVED_ITEMS_TAG, getDerivedItems, sourcePatternConds, TALK_DAY_SQL, toDateOnlyString } from "./coverage";

interface Actor { id: string; clearance: string }

const TALK_SOURCE_KEY = "talk";
const NINA_NAME = "坂井新奈";
/** 本人のトーク (本人が写る他メンバーの投稿も含む) か、本文で言及があるもの。1 日分の行に当てる */
const FOCUS_SQL = Prisma.sql`(a."mentionsNina" OR EXISTS (
  SELECT 1 FROM "AssetEntity" ae WHERE ae."assetId" = a.id AND ae."entityId" = ${NINA_ENTITY_ID}
))`;

/** `FOCUS_SQL` と同じ集合を全期間から引くときの形。OR のままだと Asset を全件なめる */
const FOCUS_IDS_SQL = Prisma.sql`a.id IN (
  SELECT ae."assetId" FROM "AssetEntity" ae WHERE ae."entityId" = ${NINA_ENTITY_ID}
  UNION SELECT m.id FROM "Asset" m WHERE m."mentionsNina"
)`;

const DAY_MS = 24 * 3600 * 1000;

/**
 * その日と前後 1 日の範囲。言及の文脈は日をまたぐことがあるので前後も読む。
 * `TALK_DAY_SQL` との文字列比較は索引が効かず 5 秒かかる (実測)
 */
function talkWindowSql(day: string): Prisma.Sql {
  const dayStart = new Date(`${day}T00:00:00+09:00`).getTime();
  const start = new Date(dayStart - DAY_MS);
  const end = new Date(dayStart + 2 * DAY_MS);
  return Prisma.sql`a."canonicalDate" >= ${start.toISOString()}::text::timestamp AND a."canonicalDate" < ${end.toISOString()}::text::timestamp`;
}

export interface TalkClip {
  id: string;
  excerpt: string;
  note: string;
  /** メモの保存先。まとめたクリップではメモを持つ行 */
  noteItemId: string;
  /** 外すときに消す行すべて */
  itemIds: string[];
}

export interface TalkMessage {
  assetId: string;
  kind: AssetKind;
  speaker: string;
  /** 本人の投稿 */
  self: boolean;
  /** 本人でない話し手の言及 */
  mention: boolean;
  /** 時刻順に並べるための ISO 文字列 */
  at: string;
  /** 表示用。別の日のメッセージは日付も付く */
  time: string;
  body: string;
  transcript: string;
  imageUrl: string | null;
  /** Drive のプレーヤー。動画・音声で Drive にあるときだけ */
  playerUrl: string | null;
  clips: TalkClip[];
  /** プールから移した先の企画 (見える範囲) */
  dossiers: { id: string; title: string }[];
}

export interface TalkDay {
  day: string;
  scope: TalkDayScope;
  messages: TalkMessage[];
  /** 言及の assetId → 同じ話し手の前後。本人・言及の表示のときだけ */
  threads: Record<string, { before: TalkMessage[]; after: TalkMessage[] }>;
  focusCount: number;
  totalCount: number;
  done: boolean;
  newerDay: string | null;
  olderDay: string | null;
  nextUnfinishedDay: string | null;
}

async function getTalkSource(tx: TransactionClient): Promise<DataSource | null> {
  return tx.dataSource.findUnique({ where: { key: TALK_SOURCE_KEY } });
}

/** 本人か言及のトークがある日。日付の集合はほとんど変わらないので長めに持つ */
function getFocusDays(clearance: string): Promise<string[]> {
  return unstable_cache(async () => {
    return withClearance(clearance, async (tx) => {
      const source = await getTalkSource(tx);
      if (!source) return [];
      const conds = [Prisma.sql`a."canonicalDate" IS NOT NULL`, FOCUS_IDS_SQL, ...sourcePatternConds(source)];
      const rows = await tx.$queryRaw<{ day: string }[]>`
        SELECT DISTINCT ${TALK_DAY_SQL}::text AS day
        FROM "Asset" a JOIN "SourceRecord" sr ON sr."assetId" = a.id
        WHERE ${Prisma.join(conds, " AND ")}
      `;
      return rows.map((r) => r.day);
    }, { timeout: 30_000 });
  }, ["talk-focus-days", clearance], { revalidate: 600, tags: [DERIVED_ITEMS_TAG] })();
}

const timeFormat = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "numeric", minute: "2-digit" });
const dateTimeFormat = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });

/** その日のトークと、付いているクリップ。無い日は null。 */
export async function getTalkDay(user: Actor, day: string, scope: TalkDayScope): Promise<TalkDay | null> {
  if (!isTalkDayKey(day)) return null;
  const [derived, focusDays] = await Promise.all([
    getDerivedItems(TALK_SOURCE_KEY, user.clearance),
    // 全期間の集計は「次の日」にしか使わない。失敗しても画面は出す
    getFocusDays(user.clearance).catch((error: unknown) => {
      console.error("talk focus days failed", error instanceof Error ? error.name : "unknown");
      return [] as string[];
    }),
  ]);
  const allDays = derived.map((d) => toDateOnlyString(d.itemDate)).filter((d): d is string => !!d);

  const result = await withSession(user, async (tx) => {
    const source = await getTalkSource(tx);
    if (!source) return null;
    const conds = [talkWindowSql(day), ...sourcePatternConds(source)];
    const window = await tx.$queryRaw<{ id: string; title: string; day: string; focus: boolean }[]>`
      SELECT DISTINCT a.id, a.title, ${TALK_DAY_SQL}::text AS day, ${FOCUS_SQL} AS focus
      FROM "Asset" a JOIN "SourceRecord" sr ON sr."assetId" = a.id
      WHERE ${Prisma.join(conds, " AND ")}
    `;
    const found = window.filter((f) => f.day === day);
    if (!found.length) return null;
    const shownIds = new Set(found.filter((f) => scope === "all" || f.focus).map((f) => f.id));
    const focusIds = new Set(found.filter((f) => f.focus).map((f) => f.id));
    const speakerOf = (title: string) => talkSpeaker(title) ?? title;
    const mentionSpeakers = new Set(found.filter((f) => f.focus).map((f) => speakerOf(f.title)).filter((s) => s !== NINA_NAME));
    // 全メンバーの表示では前後がそのまま並ぶので、文脈は読まない
    const contextIds = scope === "focus" ? window.filter((f) => mentionSpeakers.has(speakerOf(f.title))).map((f) => f.id) : [];
    const ids = [...new Set([...shownIds, ...contextIds])];

    const [assets, items, statuses] = await Promise.all([
      tx.asset.findMany({
        where: { id: { in: ids } },
        orderBy: [{ canonicalDate: "asc" }, { id: "asc" }],
        select: {
          id: true, kind: true, title: true, canonicalDate: true, thumbnailUrl: true,
          storageProvider: true, storageKey: true,
          texts: {
            where: { textType: { in: ["message_body", "transcript"] } },
            orderBy: { createdAt: "asc" },
            select: { textType: true, content: true },
          },
        },
      }),
      tx.dossierItem.findMany({
        where: { assetId: { in: ids }, kind: "asset_ref" },
        // 1 つのメッセージのクリップは作った順。メモの保存で並びが変わらないように固定する
        orderBy: { createdAt: "asc" },
        select: {
          id: true, assetId: true, note: true, excerpt: true, clipGroupId: true, sortOrder: true,
          dossier: { select: { id: true, title: true, kind: true } },
        },
      }),
      tx.materialClipStatus.findMany({ where: { dataSourceKey: TALK_SOURCE_KEY, done: true }, select: { itemKey: true } }),
    ]);

    const inPool = items.filter((i) => i.dossier.kind === DossierKind.clips);
    const groupIds = [...new Set(inPool.flatMap((i) => i.clipGroupId ? [i.clipGroupId] : []))];
    // まとめたクリップの一部が今の表示に無くても、メモと外す対象は全行で決める
    const siblings = groupIds.length ? await tx.dossierItem.findMany({
      where: { clipGroupId: { in: groupIds }, dossier: { kind: DossierKind.clips } },
      select: { id: true, note: true, clipGroupId: true, sortOrder: true },
    }) : [];
    const ungrouped = inPool.filter((i) => !i.clipGroupId);
    const groupOf = new Map(groupClipRows([...siblings, ...ungrouped]).flatMap((g) => g.members.map((m) => [m.id, g] as const)));

    const loaded = assets.map((asset): TalkMessage => {
      const body = asset.texts.find((t) => t.textType === "message_body")?.content ?? "";
      const own = items.filter((i) => i.assetId === asset.id);
      const clips = own.filter((i) => i.dossier.kind === DossierKind.clips).map((i): TalkClip => {
        const group = groupOf.get(i.id);
        return {
          id: i.id, excerpt: i.excerpt, note: group?.head.note ?? i.note, noteItemId: group?.head.id ?? i.id,
          itemIds: group?.members.map((m) => m.id) ?? [i.id],
        };
      });
      const speaker = speakerOf(asset.title);
      const fromDrive = asset.storageProvider === "gdrive" && asset.storageKey;
      return {
        assetId: asset.id, kind: asset.kind, speaker, self: speaker === NINA_NAME, mention: speaker !== NINA_NAME && focusIds.has(asset.id),
        at: asset.canonicalDate?.toISOString() ?? "",
        time: !asset.canonicalDate ? "" : (jstDayString(asset.canonicalDate) === day ? timeFormat : dateTimeFormat).format(asset.canonicalDate),
        body,
        transcript: asset.texts.find((t) => t.textType === "transcript")?.content ?? "",
        imageUrl: asset.thumbnailUrl ?? (asset.kind === "image" && fromDrive ? `/api/drive-image/${asset.storageKey}` : null),
        playerUrl: (asset.kind === "video" || asset.kind === "audio") && fromDrive
          ? `https://drive.google.com/file/d/${encodeURIComponent(asset.storageKey!)}/preview` : null,
        clips,
        dossiers: [...new Map(own.filter((i) => i.dossier.kind !== DossierKind.clips).map((i) => [i.dossier.id, { id: i.dossier.id, title: i.dossier.title }])).values()],
      };
    });
    const messages = loaded.filter((m) => shownIds.has(m.assetId));
    const threads = scope === "focus"
      ? Object.fromEntries(messages.filter((m) => m.mention).map((m) => [m.assetId, talkThread(loaded, m.assetId)]))
      : {};
    return {
      messages, threads, focusCount: focusIds.size, totalCount: found.length,
      doneDays: new Set(statuses.map((s) => s.itemKey)),
    };
  });
  if (!result) return null;

  const { newer, older } = adjacentTalkDays(allDays, day);
  return {
    day, scope, messages: result.messages, threads: result.threads, focusCount: result.focusCount, totalCount: result.totalCount,
    done: result.doneDays.has(day), newerDay: newer, olderDay: older,
    nextUnfinishedDay: nextUnfinishedTalkDay(focusDays, result.doneDays, day),
  };
}
