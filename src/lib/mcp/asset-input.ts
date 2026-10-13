import * as z from "zod";
import { $Enums } from "@prisma/client";
import type { ApiKeyUser } from "@/lib/api-auth";
import { assertClearance } from "@/lib/classification";
import { parseDateOnly } from "@/lib/domain/coverage";
import type { AssetIntakeData } from "@/lib/domain/asset-intake";
import { entityResolutionHint, resolveEntityNames, type EntityResolution } from "./entity-resolution";
import { fail } from "./result";

/**
 * アセットを作る MCP ツールの共通入力。`akashic_create_asset` (tools.ts) と
 * `akashic_complete_upload` (tools-upload.ts) が同じ引数・同じ既定値で受ける。
 */

// 形式だけでなく暦日として存在するかも見る。new Date("2026-02-30") は例外にならず
// 3/2 にロールオーバーするので、正規表現だけだと無言のデータ破損になる。
export const DATE_ONLY = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 形式で指定してください")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "存在しない日付です");

/** classification がキーのクリアランスを超えていれば失敗結果を返す。問題なければ null。 */
export function rejectAboveClearance(user: ApiKeyUser, classification: $Enums.ClearanceLevel) {
  try {
    assertClearance(user.clearance, classification);
    return null;
  } catch {
    return fail(
      `クリアランス (${user.clearance}) を超える classification (${classification}) は指定できません。`
    );
  }
}

/** `kind` 以外のアセット作成引数。`kind` は呼び出し側で必須 / 任意を決める */
export const ASSET_DRAFT_FIELDS = {
  title: z.string().describe("タイトル。一覧で識別できる短い日本語"),
  description: z.string().optional(),
  bodyText: z.string().optional().describe("本文。AssetText(body) として保存される"),
  canonicalDate: DATE_ONLY.optional().describe("公開日・放送日 (JST)。投稿日ではなく内容の日付"),
  trustLevel: z.enum($Enums.TrustLevel).optional().describe("既定は unverified"),
  sourceType: z
    .enum($Enums.SourceType)
    .optional()
    .describe(
      "省略時は discord 情報があれば discord、無ければ manual。" +
        "web はブログのアーカイブ用で、指定すると口コミ抽出が走る"
    ),
  sourceUrl: z.string().url().optional().describe("出典 URL。SourceRecord として記録される"),
  entityNames: z
    .array(z.string())
    .optional()
    .describe("紐づけたい人物・タグ・聖地の名前。正式名称は akashic_list_entities で確認する"),
  createMissingEntities: z
    .boolean()
    .optional()
    .describe(
      "true にすると、一致しなかった名前を新しいタグとして作成する。" +
        "表記ゆれで重複タグが増えるので、既存に無いと確認できたときだけ使う"
    ),
  classification: z
    .enum($Enums.ClearanceLevel)
    .optional()
    .describe("機密レベル。既定は internal。自分のクリアランスより上は指定できない"),
  discordGuildId: z.string().optional(),
  discordChannelId: z.string().optional(),
  discordMessageId: z.string().optional(),
  discordMessageUrl: z.string().optional().describe("Discord メッセージへのリンク"),
  discordAuthorId: z.string().optional(),
  discordAuthorName: z.string().optional().describe("Discord 投稿者の表示名"),
  discordPostedAt: z.string().optional().describe("Discord 投稿日時 (ISO 8601)"),
};

const AssetDraftArgs = z.object(ASSET_DRAFT_FIELDS);
type AssetDraftArgs = z.infer<typeof AssetDraftArgs>;

export type AssetDraft = {
  data: Omit<AssetIntakeData, "kind">;
  resolution: EntityResolution | null;
};

/**
 * 引数を intakeAsset に渡す形へ落とす。入力の不備は失敗結果 (`{ error }`) で返す。
 *
 * status は必ず inbox (MCP 経由の作成は人間の仕分けを通す)。
 * エンティティの名前解決もここで行うので、`createMissingEntities` ならタグが作られる。
 * 他の検証に落ちうる処理は先に済ませてから呼ぶこと。
 */
export async function prepareAssetDraft(
  args: AssetDraftArgs,
  user: ApiKeyUser
): Promise<{ draft: AssetDraft } | { error: ReturnType<typeof fail> }> {
  const classification = args.classification ?? "internal";
  const above = rejectAboveClearance(user, classification);
  if (above) return { error: above };

  let discordPostedAt: Date | null = null;
  if (args.discordPostedAt) {
    const parsed = new Date(args.discordPostedAt);
    if (isNaN(parsed.getTime())) {
      return {
        error: fail("discordPostedAt が日時として解釈できません (ISO 8601 で指定してください)。", {
          discordPostedAt: args.discordPostedAt,
        }),
      };
    }
    discordPostedAt = parsed;
  }

  const resolution = args.entityNames?.length
    ? await resolveEntityNames(args.entityNames, {
        createMissing: args.createMissingEntities,
        clearance: user.clearance,
      })
    : null;

  const hasDiscord = Boolean(
    args.discordMessageId || args.discordMessageUrl || args.discordChannelId
  );
  const sourceType = args.sourceType ?? (hasDiscord ? "discord" : "manual");

  return {
    draft: {
      resolution,
      data: {
        classification,
        title: args.title,
        description: args.description,
        // MCP 経由の作成は必ず仕分け待ちに入れる
        status: "inbox",
        trustLevel: args.trustLevel,
        canonicalDate: args.canonicalDate ? parseDateOnly(args.canonicalDate) : null,
        sourceType,
        discordGuildId: args.discordGuildId ?? null,
        discordChannelId: args.discordChannelId ?? null,
        discordMessageId: args.discordMessageId ?? null,
        discordMessageUrl: args.discordMessageUrl ?? null,
        discordAuthorId: args.discordAuthorId ?? null,
        discordAuthorName: args.discordAuthorName ?? null,
        discordPostedAt,
        texts: args.bodyText?.trim()
          ? [{ textType: "body", content: args.bodyText.trim() }]
          : undefined,
        entities: resolution?.resolved.map((e) => ({ entityId: e.id })),
        sourceRecords: args.sourceUrl
          ? [{ sourceKind: "url" as const, title: args.title, url: args.sourceUrl }]
          : undefined,
      },
    },
  };
}

/** 作成したアセットの返却形。エンティティ解決の結果と、AI 向けのヒントを添える */
export function createdAssetPayload(
  asset: { id: string; title: string; kind: string; status: string; classification: string },
  resolution: EntityResolution | null,
  baseUrl: string
) {
  const hint = resolution ? entityResolutionHint(resolution) : undefined;
  return {
    id: asset.id,
    title: asset.title,
    kind: asset.kind,
    status: asset.status,
    classification: asset.classification,
    url: `${baseUrl}/assets/${asset.id}`,
    linkedEntities: resolution?.resolved.map((e) => ({ id: e.id, name: e.name, type: e.type })) ?? [],
    ...(resolution?.created.length ? { createdEntities: resolution.created } : {}),
    ...(resolution?.unresolved.length ? { unresolvedEntities: resolution.unresolved } : {}),
    ...(resolution?.ambiguous.length ? { ambiguousEntities: resolution.ambiguous } : {}),
    ...(hint ? { hint } : {}),
  };
}
