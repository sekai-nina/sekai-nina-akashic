import type { ClearanceLevel, Prisma } from "@prisma/client";
import { prismaInternal, withClearance } from "@/lib/db";
import { recordUsage } from "@/lib/costs/usage";
import { downloadFromDrive } from "@/lib/drive";
import { OCR_FEATURE, OcrError, ocrImageWithClaude } from "@/lib/ocr/claude";
import { addTextRevision } from "./text-revisions";
import { getAssetRelations } from "./relations";

/**
 * 画像の OCR (#379)。作りは文字起こし (`./transcribe.ts`, #282) に揃える。
 *
 * - 15 分ごとの cron (`/api/cron/ocr`) が、タグ「雑誌」の画像と「まとめて OCR」で頼まれた画像を回す (`autoOcrWhere`)
 * - それ以外はアセット詳細の「OCR」ボタンで 1 件ずつ回す
 *
 * **外部 (Anthropic, 米国) に送るのは `public` / `internal` だけ。** `confidential` 以上は送らない。
 * 結果は `AssetText(textType = ocr)` に置く。`normalizedContent` の PGroonga 索引でそのまま検索に載る。
 */

export const OCR_CLEARANCES: ClearanceLevel[] = ["public", "internal"];

/** タグ「雑誌」の canonicalName。付いた画像は頼まれなくても cron が回す */
const MAGAZINE_TAG = "雑誌";

/** OCR できない理由。できるなら null。アセット詳細のボタンとサーバーアクションが同じ判定を使う */
export function ocrBlockedReason(asset: {
  kind: string;
  storageProvider: string;
  storageKey: string | null;
  classification: ClearanceLevel;
}): string | null {
  if (asset.kind !== "image") return "画像ではありません";
  if (!OCR_CLEARANCES.includes(asset.classification)) return "機密のアセットは外部に送らないため、OCR できません";
  if (asset.storageProvider !== "gdrive" || !asset.storageKey) return "Drive に置かれていないので OCR できません";
  return null;
}

/** cron が拾う対象: まだ OCR していない画像のうち、タグ「雑誌」付きか「まとめて OCR」で頼まれたもの */
export function autoOcrWhere(): Prisma.AssetWhereInput {
  return {
    kind: "image",
    storageProvider: "gdrive",
    storageKey: { not: null },
    classification: { in: OCR_CLEARANCES },
    ocrAt: null,
    // 人が入れた OCR は上書きしない
    texts: { none: { textType: "ocr" } },
    OR: [
      { ocrRequestedAt: { not: null } },
      { entities: { some: { entity: { type: "tag", canonicalName: MAGAZINE_TAG } } } },
    ],
  };
}

const ASSET_SELECT = {
  id: true,
  kind: true,
  storageProvider: true,
  storageKey: true,
  classification: true,
} as const;

type TargetAsset = Prisma.AssetGetPayload<{ select: typeof ASSET_SELECT }>;

/** Drive からの取得の上限。cron の 1 件は「取得 + Claude (最大 120 秒)」で収まる */
const DRIVE_TIMEOUT_MS = 30_000;

export type OcrOutcome =
  /** OCR できた。text が空なら文字が無かった */
  | { kind: "done"; text: string }
  /** やり直しても直らない (画像が読めない・Drive に無い・断られた)。ocrAt を立てて cron の対象から外す */
  | { kind: "failed"; error: string }
  /** 一時的な失敗。何も書かない (cron は次の回に拾い直す)。stopBatch なら cron はその回を打ち切る */
  | { kind: "retry"; error: string; stopBatch?: boolean };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Drive の 404 (消された・権限が外れた) は何度取っても同じ。403 は Drive のレート制限でも返るので一時的に扱う */
function isDriveNotFound(e: unknown): boolean {
  const err = e as { status?: number; code?: number | string; response?: { status?: number } };
  return err?.status === 404 || err?.response?.status === 404 || err?.code === 404;
}

/** Drive から落として Claude に送る。DB には書かない (書き込みは `saveOutcome`) */
async function runOcr(asset: TargetAsset): Promise<OcrOutcome> {
  const blocked = ocrBlockedReason(asset);
  if (blocked) return { kind: "failed", error: blocked };

  let data: Buffer | null;
  try {
    data = await downloadFromDrive(asset.storageKey!, { timeoutMs: DRIVE_TIMEOUT_MS });
  } catch (e) {
    if (isDriveNotFound(e)) return { kind: "failed", error: "Drive にファイルがありません" };
    return { kind: "retry", error: `Drive から取れませんでした: ${message(e)}` };
  }
  if (!data) return { kind: "retry", error: "Drive の認証情報が未設定です", stopBatch: true };

  // 読んでから送るまでの間に機密へ上げられていたら送らない (cron は最大数分かけて 1 件ずつ回す)
  const now = await prismaInternal.asset.findUnique({ where: { id: asset.id }, select: { classification: true } });
  if (!now || !OCR_CLEARANCES.includes(now.classification)) {
    return { kind: "failed", error: "機密のアセットは外部に送らないため、OCR できません" };
  }

  try {
    const result = await ocrImageWithClaude(data);
    // 利用量を /costs に自己申告する。失敗しても OCR は止めない (集計より本処理が優先)
    await recordUsage({
      provider: "anthropic",
      model: result.model,
      feature: OCR_FEATURE,
      inputTokens: result.usage.inputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
      outputTokens: result.usage.outputTokens,
      requests: 1,
    }).catch((e) => console.warn(`[ocr] 利用量の記録に失敗: ${message(e)}`));
    return { kind: "done", text: result.text };
  } catch (e) {
    if (e instanceof OcrError) {
      return e.permanent ? { kind: "failed", error: e.message } : { kind: "retry", error: e.message, stopBatch: e.stopBatch };
    }
    throw e;
  }
}

/**
 * 結果を書く。見えないアセット (RLS) には何も書かない。
 *
 * 本文は `addTextRevision` で積む (やり直しで変わったら旧本文を版に残す)。
 * **文字が無かったときは既存の本文を消さない** (人が入れた本文かもしれない)。
 * ocrAt は生 SQL で立てる (`@updatedAt` を動かすと「最近更新したアセット」に並んでしまう)
 */
async function saveOutcome(
  assetId: string,
  outcome: Exclude<OcrOutcome, { kind: "retry" }>,
  clearance: string,
): Promise<void> {
  if (outcome.kind === "done" && outcome.text) {
    const saved = await addTextRevision(
      { assetId, textType: "ocr", content: outcome.text, fetchedAt: new Date() },
      clearance,
    );
    if (!saved) return;
  }
  const error = outcome.kind === "failed" ? outcome.error : null;
  await withClearance(
    clearance,
    (tx) => tx.$executeRaw`UPDATE "Asset" SET "ocrAt" = NOW(), "ocrError" = ${error} WHERE id = ${assetId}`,
  );
}

export interface AutoOcrResult {
  done: number;
  empty: number;
  failed: number;
  retry: number;
  /** ほかの画像を送っても同じ結果になる失敗 (キーの誤り・429 など) で打ち切った */
  stopped: boolean;
  /** まだ残っている件数 (今回の分を除く) */
  remaining: number;
}

/**
 * cron 用。対象を頼まれた順 → 新しい順に、時間の許す限り 1 件ずつ回す。
 *
 * 選ぶのは RLS をバイパスする `prismaInternal` (classification を明示して絞る)。書き込みは対象の上限の
 * `internal` で `withClearance` を通すので、途中で機密に上げられたアセットには書かない。
 * 1 件の想定外の失敗で回全体を落とさない
 */
export async function autoOcr(opts: { limit: number; budgetMs: number }): Promise<AutoOcrResult> {
  const startedAt = Date.now();
  const where = autoOcrWhere();
  const targets = await prismaInternal.asset.findMany({
    where,
    select: ASSET_SELECT,
    orderBy: [{ ocrRequestedAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    take: opts.limit,
  });

  const result: AutoOcrResult = { done: 0, empty: 0, failed: 0, retry: 0, stopped: false, remaining: 0 };
  for (const asset of targets) {
    if (Date.now() - startedAt > opts.budgetMs) break;
    let outcome: OcrOutcome;
    try {
      outcome = await runOcr(asset);
      if (outcome.kind !== "retry") await saveOutcome(asset.id, outcome, "internal");
    } catch (e) {
      outcome = { kind: "retry", error: `想定外の失敗: ${message(e)}` };
    }
    if (outcome.kind === "retry") {
      result.retry++;
      console.warn(`[ocr] ${asset.id}: ${outcome.error}`);
      if (outcome.stopBatch) {
        result.stopped = true;
        break;
      }
    } else if (outcome.kind === "failed") {
      result.failed++;
      console.warn(`[ocr] ${asset.id}: ${outcome.error}`);
    } else if (outcome.text) result.done++;
    else result.empty++;
  }
  result.remaining = await prismaInternal.asset.count({ where });
  return result;
}

/**
 * アセット詳細のボタン用。見えないアセット (RLS) と対象外 (`confidential` 以上など) は弾く。
 * Claude の待ちはトランザクションの外で行う (withClearance の 15 秒上限に当たるため)
 */
export async function ocrAssetForUser(
  assetId: string,
  user: { clearance: string },
): Promise<{ error?: string; text?: string }> {
  const asset = await withClearance(user.clearance, (tx) =>
    tx.asset.findUnique({ where: { id: assetId }, select: ASSET_SELECT }),
  );
  if (!asset) return { error: "アセットが見つかりません" };
  const blocked = ocrBlockedReason(asset);
  if (blocked) return { error: blocked };

  const outcome = await runOcr(asset);
  if (outcome.kind === "retry") return { error: outcome.error };
  await saveOutcome(asset.id, outcome, user.clearance);
  if (outcome.kind === "failed") return { error: outcome.error };
  return { text: outcome.text };
}

/**
 * 子アセット一覧の「まとめて OCR」。子の画像のうち、まだ OCR していないものを OCR 待ちにする
 * (実際に回すのは cron)。対象はクライアントから受け取らず、親のリレーションから引き直す。
 * 待ちにした件数を返す
 */
export async function requestChildrenOcr(parentId: string, user: { clearance: string }): Promise<number> {
  const relations = await getAssetRelations(parentId, user.clearance);
  const childIds = relations.asSource.filter((r) => r.target.kind === "image").map((r) => r.targetId);
  if (childIds.length === 0) return 0;
  // 生 SQL にするのは @updatedAt を動かさないため (「最近更新したアセット」に子が並んでしまう)。
  // withClearance の中なので RLS は効き、見えないアセットは 0 行になる
  return withClearance(user.clearance, (tx) => tx.$executeRaw`
    UPDATE "Asset" a SET "ocrRequestedAt" = NOW()
    WHERE a.id = ANY(${childIds})
      AND a.kind = 'image'
      AND a."storageProvider" = 'gdrive'
      AND a."storageKey" IS NOT NULL
      AND a.classification::text IN ('public', 'internal')
      AND a."ocrAt" IS NULL
      AND a."ocrRequestedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "AssetText" t WHERE t."assetId" = a.id AND t."textType" = 'ocr')
  `);
}
