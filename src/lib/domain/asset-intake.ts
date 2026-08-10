import * as z from "zod";
import { $Enums } from "@prisma/client";
import { after } from "next/server";
import { createAsset, type CreateAssetData } from "./assets";
import { extractTestimonials } from "./testimonials";
import { invalidateAssetList } from "@/lib/cache";

/** 坂井新奈のentityId（口コミ抽出対象） */
export const NINA_ENTITY_ID = "cmmtp8vrg0004mo381neyztvn";

/**
 * 外部から受け取るアセット作成リクエストの検証スキーマ。
 *
 * 未知のキーは zod の既定どおり **除去する** (拒否しない)。旧実装は
 * `body as CreateAssetData` の無検証キャストで、リクエスト JSON の任意のキーが
 * createAsset の `...assetFields` 経由で `asset.create` にそのまま流れていた
 * (= クライアントが `id` を指定できた)。既存クライアントを壊さずに塞ぐため、
 * 未知キーは黙って捨て、既知キーの型だけを検証する。
 */
/**
 * 日付入力。`YYYY-MM-DD` と ISO 8601 の両方を受ける。
 *
 * `z.coerce.date()` は使えない。`new Date("2026-02-30")` が例外にならず 3/2 へ
 * ロールオーバーし、数値や真偽値まで日付に化けるため（無言のデータ破損）。
 * 日付のみの形は UTC 00:00 を補って ISO の厳格パースに乗せ、往復比較で暦日を確かめる。
 */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const DateInput = z
  .union([z.string(), z.date()])
  .superRefine((v, ctx) => {
    if (v instanceof Date) {
      if (isNaN(v.getTime())) {
        ctx.addIssue({ code: "custom", message: "不正な日付です" });
      }
      return;
    }
    const t = v.trim();
    const d = new Date(DATE_ONLY_RE.test(t) ? `${t}T00:00:00.000Z` : t);
    if (isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "日付として解釈できません (YYYY-MM-DD か ISO 8601)" });
      return;
    }
    if (DATE_ONLY_RE.test(t) && d.toISOString().slice(0, 10) !== t) {
      ctx.addIssue({ code: "custom", message: "存在しない日付です" });
    }
  })
  .transform((v) => {
    if (v instanceof Date) return v;
    const t = v.trim();
    return new Date(DATE_ONLY_RE.test(t) ? `${t}T00:00:00.000Z` : t);
  });

/** null を undefined に寄せる。旧実装が null を受理していたフィールド用 */
const nullableString = z
  .string()
  .nullish()
  .transform((v) => v ?? undefined);

/**
 * 外部から受け取るアセット作成リクエストの検証スキーマ。
 *
 * 未知のキーは zod の既定どおり **除去する** (拒否しない)。旧実装は
 * `body as CreateAssetData` の無検証キャストで、リクエスト JSON の任意のキーが
 * createAsset の `...assetFields` 経由で `asset.create` にそのまま流れていた
 * (= クライアントが `id` を指定できた)。既存クライアントを壊さずに塞ぐため、
 * 未知キーは黙って捨て、既知キーの型だけを検証する。
 *
 * 旧実装がランタイムで受理していた入力 (null や空文字) は通し続ける。
 * CreateAssetData の TS 型より実際の受理範囲が広かったため。
 */
export const AssetIntakeSchema = z.object({
  kind: z.enum($Enums.AssetKind),
  // 旧実装は falsy 判定で空文字を internal に倒していた。互換のため "" は未指定扱いにする
  classification: z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z.enum($Enums.ClearanceLevel).optional()
  ),
  title: nullableString,
  description: nullableString,
  status: z.enum($Enums.AssetStatus).optional(),
  trustLevel: z.enum($Enums.TrustLevel).optional(),
  canonicalDate: DateInput.nullish(),
  originalFilename: z.string().nullish(),
  mimeType: z.string().nullish(),
  fileSize: z.number().int().nullish(),
  sha256: z.string().nullish(),
  sourceType: z.enum($Enums.SourceType).optional(),
  storageProvider: z.enum($Enums.StorageProvider).optional(),
  storageKey: z.string().nullish(),
  storageUrl: z.string().nullish(),
  thumbnailUrl: z.string().nullish(),
  messageBodyPreview: z.string().nullish(),
  discordGuildId: z.string().nullish(),
  discordChannelId: z.string().nullish(),
  discordMessageId: z.string().nullish(),
  discordMessageUrl: z.string().nullish(),
  discordAuthorId: z.string().nullish(),
  discordAuthorName: z.string().nullish(),
  discordPostedAt: DateInput.nullish(),
  texts: z
    .array(
      z.object({
        textType: z.enum($Enums.TextType),
        content: z.string(),
        language: nullableString,
      })
    )
    .optional(),
  entities: z
    .array(z.object({ entityId: z.string(), roleLabel: nullableString }))
    .optional(),
  sourceRecords: z
    .array(
      z.object({
        sourceKind: z.enum($Enums.SourceKind),
        title: nullableString,
        url: z.string().nullish(),
        publisher: z.string().nullish(),
        publishedAt: DateInput.nullish(),
        // SourceRecord.metadata は Json 型。旧実装は配列も受理していたので形を縛らない
        metadata: z
          .unknown()
          .optional()
          .transform((v) =>
            v == null ? undefined : (v as Record<string, unknown>)
          ),
      })
    )
    .optional(),
});

/** zod のエラーを 1 行の日本語にまとめる */
export function formatIntakeError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join(" / ");
}

export type AssetIntakeData = Omit<CreateAssetData, "classification"> & {
  classification?: CreateAssetData["classification"];
};

/**
 * 外部からのアセット作成の共通経路。REST (`POST /api/v1/assets`) と
 * MCP (`akashic_create_asset`) の両方がここを通る。
 *
 * createAsset との違いは付帯処理の有無:
 * - classification の既定値 (internal) を埋める
 * - web(ブログ)由来なら口コミ抽出をバックグラウンドで走らせる
 * - 一覧のキャッシュを飛ばす (統計は 60 秒 TTL に任せる)
 *
 * クリアランス超過の書き込みは createAsset 内の assertClearance が投げる。
 * リクエストスコープ外 (CLI 等) からは after() が使えないので呼ばないこと。
 */
export async function intakeAsset(
  data: AssetIntakeData,
  userId: string | null,
  clearance: string
) {
  const asset = await createAsset(
    // `??` ではなく `||` — REST の旧実装が falsy 判定だったので、空文字も internal に倒す
    { ...data, classification: data.classification || "internal" },
    userId,
    clearance
  );

  // ブログ本文からの口コミ抽出はこのアセットだけに絞って非同期で走らせる
  if (data.sourceType === "web" && process.env.OPENAI_API_KEY) {
    after(async () => {
      try {
        await extractTestimonials({
          entityId: NINA_ENTITY_ID,
          limit: 20,
          assetId: asset.id,
        });
      } catch (err) {
        console.error("[testimonials] background extraction failed:", err);
      }
    });
  }

  // 一覧だけ飛ばす。stats は 60 秒 TTL があるので、外部 bot の連続 POST で
  // 毎回 getDashboardStats (12 万件に対する 16 本の集計) を落とす必要はない。
  invalidateAssetList();

  return asset;
}
