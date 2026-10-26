import type { ClearanceLevel, Prisma } from "@prisma/client";
import { prismaInternal, withClearance, type TransactionClient } from "@/lib/db";
import { recordUsage } from "@/lib/costs/usage";
import { downloadFromDrive } from "@/lib/drive";
import { NINA_ENTITY_ID } from "@/lib/nina";
import { GROQ_MAX_BYTES, GROQ_TRANSCRIBE_MODEL, GroqTranscribeError, transcribeWithGroq } from "@/lib/transcribe/groq";
import { mp4HasAudioTrack } from "@/lib/transcribe/mp4";
import { normalizeText } from "@/lib/utils";

/**
 * 音声・動画の文字起こし (#282)。
 *
 * - 15 分ごとの cron (`/api/cron/transcribe`) が坂井新奈のトークを自動で回す (`autoTranscribeWhere`)
 * - それ以外はアセット詳細の「文字起こし」ボタンで 1 件ずつ回す
 *
 * **外部 (Groq, 米国) に送るのは `public` / `internal` だけ。** `confidential` 以上は送らない (ユーザー判断)。
 * 結果は `AssetText(textType = transcript)` に置く。`normalizedContent` の PGroonga 索引でそのまま検索に載る。
 */

export const TRANSCRIBABLE_CLEARANCES: ClearanceLevel[] = ["public", "internal"];

export const TRANSCRIBE_FEATURE = "akashic.transcribe";

/** タグ「トーク」の canonicalName (取り込みが付ける) */
const TALK_TAG = "トーク";

/** 文字起こしの対象になりうるか (ボタンを出すかの判定にも使う) */
export function canTranscribe(asset: {
  kind: string;
  storageProvider: string;
  storageKey: string | null;
  classification: ClearanceLevel;
}): boolean {
  return (
    (asset.kind === "audio" || asset.kind === "video") &&
    asset.storageProvider === "gdrive" &&
    !!asset.storageKey &&
    TRANSCRIBABLE_CLEARANCES.includes(asset.classification)
  );
}

/**
 * cron が拾う対象: 坂井新奈とタグ「トーク」の両方が付いた、まだ文字起こししていない音声・動画。
 * タイトル (`坂井新奈トーク …`) でも同じ集合になる (2026-10-27 時点で 207 件) が、紐づきのほうが壊れにくい
 */
export function autoTranscribeWhere(): Prisma.AssetWhereInput {
  return {
    kind: { in: ["audio", "video"] },
    storageProvider: "gdrive",
    storageKey: { not: null },
    classification: { in: TRANSCRIBABLE_CLEARANCES },
    transcribedAt: null,
    AND: [
      { entities: { some: { entityId: NINA_ENTITY_ID } } },
      { entities: { some: { entity: { type: "tag", canonicalName: TALK_TAG } } } },
    ],
  };
}

const ASSET_SELECT = {
  id: true,
  kind: true,
  mimeType: true,
  fileSize: true,
  storageProvider: true,
  storageKey: true,
  classification: true,
} as const;

type TargetAsset = Prisma.AssetGetPayload<{ select: typeof ASSET_SELECT }>;

export type TranscribeOutcome =
  /** 保存した。text が空なら喋っていなかった */
  | { kind: "done"; text: string }
  /** やり直しても直らない (25 MB 超・形式)。transcribedAt を立てて cron の対象から外す */
  | { kind: "failed"; error: string }
  /** 一時的な失敗。何も書かない (cron は次の回に拾い直す)。rateLimited なら cron はその回を打ち切る */
  | { kind: "retry"; error: string; rateLimited?: boolean };

/** Drive から落として Groq に送る。DB には書かない (書き込みは `saveOutcome`) */
async function runTranscription(asset: TargetAsset): Promise<TranscribeOutcome> {
  if (!canTranscribe(asset)) return { kind: "failed", error: "文字起こしの対象外です" };
  if (asset.fileSize != null && asset.fileSize > GROQ_MAX_BYTES) {
    return { kind: "failed", error: `ファイルが ${Math.round(asset.fileSize / 1024 / 1024)} MB で、25 MB を超えています` };
  }

  let data: Buffer | null;
  try {
    data = await downloadFromDrive(asset.storageKey!);
  } catch (e) {
    return { kind: "retry", error: `Drive から取れませんでした: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!data) return { kind: "retry", error: "Drive の認証情報が未設定です" };
  // 画面だけで音声トラックの無い動画は送らない (トーク動画の 2/3 がこれ。2026-10-27 時点で 167 件中 109 件)
  if (mp4HasAudioTrack(data) === false) return { kind: "done", text: "" };

  try {
    const result = await transcribeWithGroq(data, asset.mimeType);
    // 利用量を /costs に自己申告する。失敗しても文字起こしは止めない (集計より本処理が優先)
    await recordUsage({
      provider: "groq",
      model: GROQ_TRANSCRIBE_MODEL,
      feature: TRANSCRIBE_FEATURE,
      inputTokens: result.billedSec,
      requests: 1,
    }).catch((e) => console.warn(`[transcribe] 利用量の記録に失敗: ${e instanceof Error ? e.message : String(e)}`));
    return { kind: "done", text: result.text };
  } catch (e) {
    if (e instanceof GroqTranscribeError) {
      return e.permanent ? { kind: "failed", error: e.message } : { kind: "retry", error: e.message, rateLimited: e.rateLimited };
    }
    throw e;
  }
}

/**
 * 結果を書く。本文は既存の transcript を置き換える (やり直しのとき)。喋っていなければ消す。
 * transcribedAt は生 SQL で立てる (`@updatedAt` を動かすと「最近更新したアセット」に並んでしまう)
 */
async function saveOutcome(
  db: TransactionClient | typeof prismaInternal,
  assetId: string,
  outcome: Exclude<TranscribeOutcome, { kind: "retry" }>,
  userId: string | null,
): Promise<void> {
  if (outcome.kind === "done") {
    const existing = await db.assetText.findFirst({
      where: { assetId, textType: "transcript" },
      select: { id: true },
    });
    if (outcome.text) {
      const data = { content: outcome.text, normalizedContent: normalizeText(outcome.text), language: "ja" };
      if (existing) await db.assetText.update({ where: { id: existing.id }, data });
      else await db.assetText.create({ data: { ...data, assetId, textType: "transcript", createdById: userId } });
    } else if (existing) {
      await db.assetText.delete({ where: { id: existing.id } });
    }
  }
  const error = outcome.kind === "failed" ? outcome.error : null;
  await db.$executeRaw`UPDATE "Asset" SET "transcribedAt" = NOW(), "transcribeError" = ${error} WHERE id = ${assetId}`;
}

export interface AutoTranscribeResult {
  done: number;
  empty: number;
  failed: number;
  retry: number;
  /** まだ残っている件数 (今回の分を除く) */
  remaining: number;
}

/**
 * cron 用。対象を新しい順に、時間の許す限り 1 件ずつ回す。RLS をバイパスする `prismaInternal` だが、
 * 絞り込みに classification を明示しているので `confidential` 以上には触れない
 */
export async function autoTranscribe(opts: { limit: number; budgetMs: number }): Promise<AutoTranscribeResult> {
  const startedAt = Date.now();
  const where = autoTranscribeWhere();
  const targets = await prismaInternal.asset.findMany({
    where,
    select: ASSET_SELECT,
    orderBy: { createdAt: "desc" },
    take: opts.limit,
  });

  const result: AutoTranscribeResult = { done: 0, empty: 0, failed: 0, retry: 0, remaining: 0 };
  for (const asset of targets) {
    if (Date.now() - startedAt > opts.budgetMs) break;
    const outcome = await runTranscription(asset);
    if (outcome.kind === "retry") {
      result.retry++;
      console.warn(`[transcribe] ${asset.id}: ${outcome.error}`);
      if (outcome.rateLimited) break;
      continue;
    }
    await saveOutcome(prismaInternal, asset.id, outcome, null);
    if (outcome.kind === "failed") {
      result.failed++;
      console.warn(`[transcribe] ${asset.id}: ${outcome.error}`);
    } else if (outcome.text) result.done++;
    else result.empty++;
  }
  result.remaining = await prismaInternal.asset.count({ where });
  return result;
}

/**
 * アセット詳細のボタン用。見えないアセット (RLS) と対象外 (`confidential` 以上など) は弾く。
 * Groq の待ちはトランザクションの外で行う (withClearance の 15 秒上限に当たるため)
 */
export async function transcribeAssetForUser(
  assetId: string,
  user: { id: string; clearance: string },
): Promise<{ error?: string; text?: string }> {
  const asset = await withClearance(user.clearance, (tx) =>
    tx.asset.findUnique({ where: { id: assetId }, select: ASSET_SELECT }),
  );
  if (!asset) return { error: "アセットが見つかりません" };
  if (!canTranscribe(asset)) {
    return { error: TRANSCRIBABLE_CLEARANCES.includes(asset.classification) ? "文字起こしの対象外です" : "機密のアセットは外部に送らないため、文字起こしできません" };
  }

  const outcome = await runTranscription(asset);
  if (outcome.kind === "retry") return { error: outcome.error };
  await withClearance(user.clearance, (tx) => saveOutcome(tx, asset.id, outcome, user.id));
  if (outcome.kind === "failed") return { error: outcome.error };
  return { text: outcome.text };
}
