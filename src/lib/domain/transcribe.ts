import type { ClearanceLevel, Prisma } from "@prisma/client";
import { prismaInternal, withClearance } from "@/lib/db";
import { recordUsage } from "@/lib/costs/usage";
import { downloadFromDrive } from "@/lib/drive";
import { NINA_ENTITY_ID } from "@/lib/nina";
import { GROQ_MAX_BYTES, GROQ_TRANSCRIBE_MODEL, GroqTranscribeError, transcribeWithGroq } from "@/lib/transcribe/groq";
import { mp4HasAudioTrack } from "@/lib/transcribe/mp4";
import { addTextRevision } from "./text-revisions";

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

/**
 * 文字起こしできない理由。できるなら null。アセット詳細のボタンとサーバーアクションが同じ判定を使う
 */
export function transcribeBlockedReason(asset: {
  kind: string;
  storageProvider: string;
  storageKey: string | null;
  classification: ClearanceLevel;
}): string | null {
  if (asset.kind !== "audio" && asset.kind !== "video") return "音声・動画ではありません";
  if (!TRANSCRIBABLE_CLEARANCES.includes(asset.classification)) {
    return "機密のアセットは外部に送らないため、文字起こしできません";
  }
  if (asset.storageProvider !== "gdrive" || !asset.storageKey) return "Drive に置かれていないので文字起こしできません";
  return null;
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
    // 人が入れた文字起こしは上書きしない
    texts: { none: { textType: "transcript" } },
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

/** Drive からの取得の上限。cron の 1 件は「取得 + Groq (GROQ_TIMEOUT_MS)」で収まる */
const DRIVE_TIMEOUT_MS = 30_000;

export type TranscribeOutcome =
  /** 文字起こしできた。text が空なら喋っていなかった */
  | { kind: "done"; text: string }
  /** やり直しても直らない (25 MB 超・形式・Drive に無い)。transcribedAt を立てて cron の対象から外す */
  | { kind: "failed"; error: string }
  /** 一時的な失敗。何も書かない (cron は次の回に拾い直す)。stopBatch なら cron はその回を打ち切る */
  | { kind: "retry"; error: string; stopBatch?: boolean };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Drive の 404 (消された・権限が外れた) は何度取っても同じ。403 は Drive のレート制限でも返るので一時的に扱う */
function isDriveNotFound(e: unknown): boolean {
  const err = e as { status?: number; code?: number | string; response?: { status?: number } };
  return err?.status === 404 || err?.response?.status === 404 || err?.code === 404;
}

/** Drive から落として Groq に送る。DB には書かない (書き込みは `saveOutcome`) */
async function runTranscription(asset: TargetAsset): Promise<TranscribeOutcome> {
  const blocked = transcribeBlockedReason(asset);
  if (blocked) return { kind: "failed", error: blocked };
  if (asset.fileSize != null && asset.fileSize > GROQ_MAX_BYTES) {
    return { kind: "failed", error: `ファイルが ${Math.round(asset.fileSize / 1024 / 1024)} MB で、25 MB を超えています` };
  }

  let data: Buffer | null;
  try {
    data = await downloadFromDrive(asset.storageKey!, { timeoutMs: DRIVE_TIMEOUT_MS });
  } catch (e) {
    if (isDriveNotFound(e)) return { kind: "failed", error: "Drive にファイルがありません" };
    return { kind: "retry", error: `Drive から取れませんでした: ${message(e)}` };
  }
  if (!data) return { kind: "retry", error: "Drive の認証情報が未設定です", stopBatch: true };
  // 画面だけで音声トラックの無い動画は送らない (トーク動画の 2/3 がこれ。2026-10-27 時点で 167 件中 109 件)
  if (mp4HasAudioTrack(data) === false) return { kind: "done", text: "" };

  // 読んでから送るまでの間に機密へ上げられていたら送らない (cron は最大数分かけて 1 件ずつ回す)
  const now = await prismaInternal.asset.findUnique({ where: { id: asset.id }, select: { classification: true } });
  if (!now || !TRANSCRIBABLE_CLEARANCES.includes(now.classification)) {
    return { kind: "failed", error: "機密のアセットは外部に送らないため、文字起こしできません" };
  }

  try {
    const result = await transcribeWithGroq(data, asset.mimeType);
    // 利用量を /costs に自己申告する。失敗しても文字起こしは止めない (集計より本処理が優先)
    await recordUsage({
      provider: "groq",
      model: GROQ_TRANSCRIBE_MODEL,
      feature: TRANSCRIBE_FEATURE,
      inputTokens: result.billedSec,
      requests: 1,
    }).catch((e) => console.warn(`[transcribe] 利用量の記録に失敗: ${message(e)}`));
    return { kind: "done", text: result.text };
  } catch (e) {
    if (e instanceof GroqTranscribeError) {
      return e.permanent ? { kind: "failed", error: e.message } : { kind: "retry", error: e.message, stopBatch: e.stopBatch };
    }
    throw e;
  }
}

/**
 * 結果を書く。見えないアセット (RLS) には何も書かない。
 *
 * 本文は `addTextRevision` で積む。やり直しで本文が変わったら旧本文を版に残し、抜粋 (クリップ・記事の出典)
 * の範囲を探し直す。**喋っていなかったときは既存の本文を消さない** (人が入れた本文かもしれない)。
 * transcribedAt は生 SQL で立てる (`@updatedAt` を動かすと「最近更新したアセット」に並んでしまう)
 */
async function saveOutcome(
  assetId: string,
  outcome: Exclude<TranscribeOutcome, { kind: "retry" }>,
  clearance: string,
): Promise<void> {
  if (outcome.kind === "done" && outcome.text) {
    const saved = await addTextRevision(
      { assetId, textType: "transcript", content: outcome.text, fetchedAt: new Date() },
      clearance,
    );
    if (!saved) return;
  }
  const error = outcome.kind === "failed" ? outcome.error : null;
  await withClearance(
    clearance,
    (tx) => tx.$executeRaw`UPDATE "Asset" SET "transcribedAt" = NOW(), "transcribeError" = ${error} WHERE id = ${assetId}`,
  );
}

export interface AutoTranscribeResult {
  done: number;
  empty: number;
  failed: number;
  retry: number;
  /** ほかのファイルを送っても同じ結果になる失敗 (キーの誤り・429 など) で打ち切った */
  stopped: boolean;
  /** まだ残っている件数 (今回の分を除く) */
  remaining: number;
}

/**
 * cron 用。対象を新しい順に、時間の許す限り 1 件ずつ回す。
 *
 * 選ぶのは RLS をバイパスする `prismaInternal` (classification を明示して絞る)。書き込みは対象の上限の
 * `internal` で `withClearance` を通すので、途中で機密に上げられたアセットには書かない。
 * 1 件の想定外の失敗で回全体を落とさない (落とすと、同じ一番新しいアセットで毎回止まる)
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

  const result: AutoTranscribeResult = { done: 0, empty: 0, failed: 0, retry: 0, stopped: false, remaining: 0 };
  for (const asset of targets) {
    if (Date.now() - startedAt > opts.budgetMs) break;
    let outcome: TranscribeOutcome;
    try {
      outcome = await runTranscription(asset);
      if (outcome.kind !== "retry") await saveOutcome(asset.id, outcome, "internal");
    } catch (e) {
      outcome = { kind: "retry", error: `想定外の失敗: ${message(e)}` };
    }
    if (outcome.kind === "retry") {
      result.retry++;
      console.warn(`[transcribe] ${asset.id}: ${outcome.error}`);
      if (outcome.stopBatch) {
        result.stopped = true;
        break;
      }
    } else if (outcome.kind === "failed") {
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
  user: { clearance: string },
): Promise<{ error?: string; text?: string }> {
  const asset = await withClearance(user.clearance, (tx) =>
    tx.asset.findUnique({ where: { id: assetId }, select: ASSET_SELECT }),
  );
  if (!asset) return { error: "アセットが見つかりません" };
  const blocked = transcribeBlockedReason(asset);
  if (blocked) return { error: blocked };

  const outcome = await runTranscription(asset);
  if (outcome.kind === "retry") return { error: outcome.error };
  await saveOutcome(asset.id, outcome, user.clearance);
  if (outcome.kind === "failed") return { error: outcome.error };
  return { text: outcome.text };
}
