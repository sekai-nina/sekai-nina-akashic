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
