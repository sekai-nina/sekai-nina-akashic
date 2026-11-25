import type { Prisma } from "@prisma/client";

/**
 * 動画の場面の一覧を「データの種類」で絞る。
 * 種類は取り込み元 (SourceRecord.publisher) と番組タグから決める。1 本は 1 種類にだけ入る
 * (トーク・TikTok・ゲームを先に判定し、番組はそのどれでもないもの、その他は何にも当たらないもの)。
 */
export const SCENE_VIDEO_KINDS = ["program", "talk", "tiktok", "game", "other"] as const;
export type SceneVideoKind = (typeof SCENE_VIDEO_KINDS)[number];

export const SCENE_VIDEO_KIND_LABELS: Record<SceneVideoKind, string> = {
  program: "番組・配信", talk: "トーク", tiktok: "TikTok", game: "ゲーム", other: "その他",
};

/** Lemino の取り込みは publisher の末尾に改行が付いたものもあるので前方一致で見る */
const PROGRAM_PUBLISHER_PREFIXES = ["Lemino", "日向坂ちゃんねる"];
/** 取り込み元が残っていない番組もタグで拾う */
const PROGRAM_TAGS = ["日向坂で会いましょう", "日向坂になりましょう", "まだまだ！日向坂で会いましょう", "外番組", "日向坂ちゃんねる", "日向坂46公式チャンネル"];

const publisherIs = (names: string[]): Prisma.AssetWhereInput => ({ sourceRecords: { some: { publisher: { in: names } } } });
const talk = publisherIs(["Talk (Sony Music)"]);
const tiktok = publisherIs(["TikTok"]);
const game = publisherIs(["ひなこい", "UNI'S ON AIR"]);
const program: Prisma.AssetWhereInput = { OR: [
  ...PROGRAM_PUBLISHER_PREFIXES.map((p) => ({ sourceRecords: { some: { publisher: { startsWith: p } } } })),
  { entities: { some: { entity: { type: "tag", canonicalName: { in: PROGRAM_TAGS } } } } },
] };
const notOthers = { NOT: [talk, tiktok, game] };

export function parseSceneVideoKind(value: string | undefined): SceneVideoKind | null {
  return SCENE_VIDEO_KINDS.find((k) => k === value) ?? null;
}

export function sceneVideoKindWhere(kind: SceneVideoKind | null): Prisma.AssetWhereInput {
  switch (kind) {
    case null: return {};
    case "talk": return talk;
    case "tiktok": return tiktok;
    case "game": return game;
    case "program": return { AND: [program, notOthers] };
    case "other": return { NOT: [talk, tiktok, game, program] };
  }
}

/** 長さの区切り。長さ不明 (null) の動画はどれにも入らない (「すべて」には出る) */
export const SCENE_VIDEO_LENGTHS = ["short", "medium", "long"] as const;
export type SceneVideoLength = (typeof SCENE_VIDEO_LENGTHS)[number];
export const SCENE_VIDEO_LENGTH_LABELS: Record<SceneVideoLength, string> = { short: "〜1分", medium: "1〜10分", long: "10分以上" };

export function parseSceneVideoLength(value: string | undefined): SceneVideoLength | null {
  return SCENE_VIDEO_LENGTHS.find((k) => k === value) ?? null;
}

export function sceneVideoLengthWhere(length: SceneVideoLength | null): Prisma.AssetWhereInput {
  switch (length) {
    case null: return {};
    case "short": return { durationSec: { lt: 60 } };
    case "medium": return { durationSec: { gte: 60, lt: 600 } };
    case "long": return { durationSec: { gte: 600 } };
  }
}

export const SCENE_VIDEO_SORTS = ["new", "longest"] as const;
export type SceneVideoSort = (typeof SCENE_VIDEO_SORTS)[number];
export const SCENE_VIDEO_SORT_LABELS: Record<SceneVideoSort, string> = { new: "新しい順", longest: "長い順" };

export function parseSceneVideoSort(value: string | undefined): SceneVideoSort {
  return value === "longest" ? "longest" : "new";
}

export function sceneVideoOrderBy(sort: SceneVideoSort): Prisma.AssetOrderByWithRelationInput[] {
  return sort === "longest"
    ? [{ durationSec: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "desc" }]
    : [{ createdAt: "desc" }, { id: "desc" }];
}

/** 一覧の絞り込みと並びをまとめたもの。URL の ?kind= / ?length= / ?sort= と 1 対 1 */
export type SceneVideoQuery = { kind: SceneVideoKind | null; length: SceneVideoLength | null; sort: SceneVideoSort };

export function sceneVideoListHref(q: SceneVideoQuery, page = 1) {
  const params = new URLSearchParams();
  if (q.kind) params.set("kind", q.kind);
  if (q.length) params.set("length", q.length);
  if (q.sort !== "new") params.set("sort", q.sort);
  if (page > 1) params.set("page", String(page));
  const s = params.toString();
  return s ? `/video-scenes?${s}` : "/video-scenes";
}

/** 詳細ページの「← 動画の場面」で一覧の条件に戻すため、`?back=` に入れた一覧の検索文字列を安全な一覧 URL に組み直す */
export function sceneVideoListHrefFromSearch(search: string | undefined) {
  const params = new URLSearchParams(search ?? "");
  const page = Math.min(5000, Math.max(1, Math.floor(Number(params.get("page")) || 1)));
  return sceneVideoListHref({
    kind: parseSceneVideoKind(params.get("kind") ?? undefined),
    length: parseSceneVideoLength(params.get("length") ?? undefined),
    sort: parseSceneVideoSort(params.get("sort") ?? undefined),
  }, page);
}

/** カードに出す長さ。1 時間以上は h:mm:ss */
export function formatVideoDuration(sec: number | null): string | null {
  if (sec == null) return null;
  const t = Math.round(sec);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
