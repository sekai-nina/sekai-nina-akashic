/**
 * ミーグリの予告コーデ (#203)。
 *
 * 本人がブログ / トークで事前に公言した「次回以降のミーグリでのコーデ」を MeetGreet に持たせる。
 * 公開サイトの「次回以降のミーグリ」はビルド時に `GET /api/v1/meetgreets/upcoming` を読む
 * (それまでは sekai-nina-site の `src/data/meetgreet-upcoming.json` を手で書き換えていた)。
 *
 * - **公開条件は「予告が空でない かつ 開催日が今日 (JST) 以降」だけ。** 本人が公言した情報なので
 *   下書きの段階は設けない
 * - 出典は Asset の ID (`previewSourceAssetIds`)。記念日と同じく Asset のタイトルと SourceRecord から
 *   ラベル・URL を作る。FK は張っていないので、消えた / 見えない ID は読むときに落とす
 * - 入口は 2 つ: アセットページ (読んでいるブログ / トークから、開催予定の回にまとめて書く) と
 *   `/meetgreets/[id]` (1 回分の文面と出典を直す)
 */

import type { MeetGreetFormat, Prisma } from "@prisma/client";
import { withClearance } from "@/lib/db";
import { toJstDateOnly, todayJst } from "@/lib/utils";
import { logAudit } from "./audit";
import { MeetGreetInputError, type ActingUser } from "./meetgreets";

export const PREVIEW_OUTFIT_MAX = 500;
/** 1 回に付けられる出典の数。実データはブログ 1 + トーク 1 */
export const PREVIEW_SOURCES_MAX = 10;

export interface PreviewSource {
  assetId: string;
  /** アセットのタイトル (`坂井新奈ブログ「夜ってすてき」` / `坂井新奈トーク 2026.4.22 16:37`) */
  title: string;
  /** 投稿日 (JST)。無ければ null */
  date: string | null;
  /** 元ページの URL。トークのように公開 URL が無いものは null */
  url: string | null;
}

const sourceSelect = {
  id: true,
  title: true,
  canonicalDate: true,
  sourceRecords: { select: { url: true }, orderBy: { createdAt: "asc" as const }, take: 1 },
} satisfies Prisma.AssetSelect;

type SourceAsset = Prisma.AssetGetPayload<{ select: typeof sourceSelect }>;

function toPreviewSource(a: SourceAsset): PreviewSource {
  return {
    assetId: a.id,
    title: a.title,
    date: toJstDateOnly(a.canonicalDate),
    url: a.sourceRecords[0]?.url ?? null,
  };
}

/** ID → 出典。見えない (クリアランス外) / 消えたアセットは入らない */
async function loadSources(tx: Prisma.TransactionClient, ids: string[]): Promise<Map<string, PreviewSource>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const assets = await tx.asset.findMany({ where: { id: { in: unique } }, select: sourceSelect });
  return new Map(assets.map((a) => [a.id, toPreviewSource(a)]));
}

function normalizeOutfit(outfit: string): string {
  const v = outfit.trim();
  if (v.length > PREVIEW_OUTFIT_MAX) {
    throw new MeetGreetInputError(`予告コーデは ${PREVIEW_OUTFIT_MAX} 文字以内です`);
  }
  return v;
}

function normalizeSourceIds(ids: string[]): string[] {
  const v = [...new Set(ids.map((s) => s.trim()).filter(Boolean))];
  if (v.length > PREVIEW_SOURCES_MAX) {
    throw new MeetGreetInputError(`出典は ${PREVIEW_SOURCES_MAX} 件までです`);
  }
  return v;
}

export interface UpcomingPreview {
  id: string;
  date: string;
  format: MeetGreetFormat;
  single: string;
  label: string;
  venue: string | null;
  outfit: string;
  sources: PreviewSource[];
}

/**
 * 公開サイトに出す予告。開催日が `today` (既定は今日の JST) 以降で、予告が空でない回を開催日順に。
 * 出典は `previewSourceAssetIds` の並び順を保つ。
 */
export async function listUpcomingPreviews(clearance: string, today = todayJst()): Promise<UpcomingPreview[]> {
  return withClearance(clearance, async (tx) => {
    const rows = await tx.meetGreet.findMany({
      where: { date: { gte: today }, previewOutfit: { not: "" } },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        date: true,
        format: true,
        single: true,
        label: true,
        venue: true,
        previewOutfit: true,
        previewSourceAssetIds: true,
      },
    });
    const sources = await loadSources(tx, rows.flatMap((r) => r.previewSourceAssetIds));
    return rows.map((r) => ({
      id: r.id,
      date: r.date,
      format: r.format,
      single: r.single,
      label: r.label,
      venue: r.venue,
      outfit: r.previewOutfit,
      sources: r.previewSourceAssetIds.flatMap((id) => sources.get(id) ?? []),
    }));
  });
}

/** `/meetgreets/[id]` の予告欄に出す出典 (見えるものだけ) */
export async function getPreviewSources(clearance: string, ids: string[]): Promise<PreviewSource[]> {
  if (ids.length === 0) return [];
  const map = await withClearance(clearance, (tx) => loadSources(tx, ids));
  return ids.flatMap((id) => map.get(id) ?? []);
}

/**
 * 1 回分の予告と出典を書き換える (`/meetgreets/[id]`)。
 * 出典は**全置換**。見えないアセット (クリアランス外 / 存在しない) を指していたら断る。
 */
export async function setMeetGreetPreview(
  user: ActingUser,
  id: string,
  input: { outfit: string; sourceAssetIds: string[] }
) {
  const outfit = normalizeOutfit(input.outfit);
  const sourceIds = normalizeSourceIds(input.sourceAssetIds);

  await withClearance(user.clearance, async (tx) => {
    const found = await loadSources(tx, sourceIds);
    const missing = sourceIds.filter((s) => !found.has(s));
    if (missing.length) throw new MeetGreetInputError(`出典のアセットが見つかりません: ${missing.join(", ")}`);
    const res = await tx.meetGreet.updateMany({
      where: { id },
      data: { previewOutfit: outfit, previewSourceAssetIds: sourceIds },
    });
    if (res.count === 0) throw new MeetGreetInputError("見つかりません");
  });

  await logAudit({
    actorId: user.id,
    action: "meetgreet.preview",
    targetType: "MeetGreet",
    targetId: id,
    metadata: { outfit, sources: sourceIds.length },
  });
}

export interface PreviewTarget {
  id: string;
  date: string;
  format: MeetGreetFormat;
  label: string;
  outfit: string;
  /** このアセットがもう出典に入っているか */
  linked: boolean;
}

/** アセットページの「ミーグリの予告を登録」に並べる、開催日が今日 (JST) 以降の回 */
export async function listPreviewTargets(user: ActingUser, assetId: string, today = todayJst()): Promise<PreviewTarget[]> {
  const rows = await withClearance(user.clearance, (tx) =>
    tx.meetGreet.findMany({
      where: { date: { gte: today } },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      select: { id: true, date: true, format: true, label: true, previewOutfit: true, previewSourceAssetIds: true },
    })
  );
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    format: r.format,
    label: r.label,
    outfit: r.previewOutfit,
    linked: r.previewSourceAssetIds.includes(assetId),
  }));
}

/**
 * アセットページから、開催予定の回にまとめて予告を書く。
 *
 * - 予告を書いた回: 予告を上書きし、このアセットを出典に足す (既にあれば足さない)
 * - 予告を空にした回: 予告を消し、このアセットを出典から外す
 * - 渡されなかった回: 触らない
 *
 * 1 本のブログで数回分を予告するのが普通なので、1 トランザクションでまとめて書く。
 */
export async function setPreviewsFromAsset(
  user: ActingUser,
  assetId: string,
  entries: { meetGreetId: string; outfit: string }[]
): Promise<{ updated: number }> {
  if (entries.length === 0) throw new MeetGreetInputError("更新する回がありません");
  const normalized = entries.map((e) => ({ id: e.meetGreetId, outfit: normalizeOutfit(e.outfit) }));

  const updated = await withClearance(user.clearance, async (tx) => {
    const asset = await tx.asset.findUnique({ where: { id: assetId }, select: { id: true } });
    if (!asset) throw new MeetGreetInputError("アセットが見つかりません");
    const rows = await tx.meetGreet.findMany({
      where: { id: { in: normalized.map((e) => e.id) } },
      select: { id: true, previewOutfit: true, previewSourceAssetIds: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    let count = 0;
    for (const e of normalized) {
      const row = byId.get(e.id);
      if (!row) throw new MeetGreetInputError("見つからない回が含まれています");
      const others = row.previewSourceAssetIds.filter((s) => s !== assetId);
      const sources = e.outfit ? [...others, assetId] : others;
      // 並び順を保つ: 既に入っていた位置はそのまま
      const nextSources = e.outfit && row.previewSourceAssetIds.includes(assetId) ? row.previewSourceAssetIds : sources;
      if (row.previewOutfit === e.outfit && sameList(row.previewSourceAssetIds, nextSources)) continue;
      if (nextSources.length > PREVIEW_SOURCES_MAX) {
        throw new MeetGreetInputError(`出典は ${PREVIEW_SOURCES_MAX} 件までです`);
      }
      await tx.meetGreet.update({
        where: { id: e.id },
        data: { previewOutfit: e.outfit, previewSourceAssetIds: nextSources },
      });
      count++;
    }
    return count;
  });

  if (updated > 0) {
    await logAudit({
      actorId: user.id,
      action: "meetgreet.preview",
      targetType: "Asset",
      targetId: assetId,
      metadata: { updated },
    });
  }
  return { updated };
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
