import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type {
  AssetKind,
  AssetStatus,
  ClearanceLevel,
  EntityType,
  SourceType,
  TextType,
  TrustLevel,
} from "@prisma/client";
import type { ApiKeyUser } from "@/lib/api-auth";
import { withClearance } from "@/lib/db";
import { assertClearance, isClassificationDowngrade } from "@/lib/classification";
import { invalidateAssets, invalidatePlaces } from "@/lib/cache";
import { parseDateOnly } from "@/lib/domain/coverage";
import { getAsset, updateAsset } from "@/lib/domain/assets";
import { intakeAsset } from "@/lib/domain/asset-intake";
import { listEntities, searchEntities } from "@/lib/domain/entities";
import { createPlace, getPlaceById, listPlaces, updatePlace } from "@/lib/domain/places";
import { search, type SearchQuery } from "@/lib/search";
import { normalizeText } from "@/lib/utils";
import { resolveGoogleMapsUrl } from "@/lib/places/resolve-google-maps-url";
import { logMcpToolCall } from "./audit";
import { entityResolutionHint, resolveEntityNames } from "./entity-resolution";
import { toAssetDetail, toEntitySummary, toPlaceSummary, toSearchItem } from "./format";

// ============================================================
// 共通ヘルパー
// ============================================================

const ASSET_KINDS = ["image", "video", "audio", "text", "document", "other"] as const;
const ASSET_STATUSES = ["inbox", "triaging", "organized", "archived"] as const;
const TRUST_LEVELS = ["unverified", "low", "medium", "high", "official"] as const;
const SOURCE_TYPES = ["web", "manual", "discord", "import"] as const;
const ENTITY_TYPES = ["person", "place", "source", "event", "tag"] as const;
const CLEARANCE_LEVELS = ["public", "internal", "confidential", "restricted"] as const;
const TEXT_TYPES = [
  "title",
  "body",
  "description",
  "message_body",
  "ocr",
  "transcript",
  "note",
  "extracted",
  "annotation",
] as const;

// 形式だけでなく暦日として存在するかも見る。new Date("2026-02-30") は例外にならず
// 3/2 にロールオーバーするので、正規表現だけだと無言のデータ破損になる。
const DEFAULT_PER_PAGE = 20;

const DATE_ONLY = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 形式で指定してください")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "存在しない日付です");

/** ツール結果 (成功) — JSON をテキストとして返す */
function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/** ツール結果 (失敗) — isError を立てて AI にリトライさせる */
function fail(message: string, detail?: Record<string, unknown>) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: message, ...(detail ?? {}) }, null, 2),
      },
    ],
  };
}

/**
 * 機密レベルの引き下げを拒否する。問題なければ null。
 *
 * assertClearance は上位を付ける操作しか止めないので、restricted -> public のような
 * 引き下げは素通りする。MCP は LLM がツールを呼ぶ経路で、プロンプトインジェクション
 * 1 回で機密アセットを公開扱いに落とせてしまうため、既存レコードの再分類は
 * 「引き上げのみ」に制限する。引き下げは画面から人間が行う。
 */
function rejectClassificationDowngrade(
  current: string,
  requested: string | undefined
) {
  if (!requested) return null;
  if (!isClassificationDowngrade(current, requested)) return null;
  return fail(
    `機密レベルの引き下げ (${current} -> ${requested}) は MCP からは行えません。` +
      `引き上げのみ可能です。引き下げが必要なら画面から操作してください。`
  );
}

/** Google Maps URL の解決失敗を、原因ごとの文言に落とす */
function failResolveUrl(
  error: "invalid_url" | "unsupported_host" | "no_coordinates",
  googleMapsUrl: string,
  expanded?: string
) {
  if (error === "invalid_url") {
    return fail("googleMapsUrl が URL として解釈できません。", { googleMapsUrl });
  }
  if (error === "unsupported_host") {
    return fail(
      "Google Maps 以外の URL は受け付けません。maps.google.com / google.com/maps / maps.app.goo.gl の URL を渡してください。",
      { googleMapsUrl, ...(expanded && expanded !== googleMapsUrl ? { expanded } : {}) }
    );
  }
  return fail(
    "URL から緯度経度を取り出せませんでした。latitude / longitude を直接指定してください。",
    { ...(expanded ? { expanded } : {}) }
  );
}

/**
 * domain 層が投げた例外を AI に読める形へ落とす。
 * Prisma のエラーはスタックにサーバーのパスやクエリが載るので、そのままは返さない。
 */
function toToolError(err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : String(err);

  if (message.includes("Access denied")) {
    return fail("クリアランスが足りないため、この操作は実行できません。");
  }
  if (message.includes("Unique constraint failed")) {
    return fail("同じものが既に登録されています。一覧で確認してから更新ツールを使ってください。");
  }
  if (message.includes("not found") || message.includes("No record was found")) {
    return fail("対象が見つかりません。ID を確認してください。");
  }

  // 未知のエラーは 1 行目だけ返す（スタックとクエリは落とす）
  return fail(fallback, { detail: message.split("\n")[0].slice(0, 200) });
}

function hasWrite(user: ApiKeyUser): boolean {
  return user.permissions.includes("write");
}

// ============================================================
// ツール登録
// ============================================================

export interface ToolContext {
  user: ApiKeyUser;
  baseUrl: string;
}

/**
 * MCP サーバーにツールを登録する。
 *
 * ハンドラは毎リクエスト新しい McpServer に対して呼ばれるので、キーの
 * permissions を見て登録するツール自体を変えられる。write を持たないキーには
 * 書き込みツールを **そもそも見せない** (tools/list に出さない)。
 */
export function registerAkashicTools(server: McpServer, ctx: ToolContext) {
  registerReadTools(server, ctx);
  if (hasWrite(ctx.user)) {
    registerWriteTools(server, ctx);
  }
}

// ------------------------------------------------------------
// 読み取り
// ------------------------------------------------------------

function registerReadTools(server: McpServer, { user, baseUrl }: ToolContext) {
  server.registerTool(
    "akashic_search",
    {
      title: "アセット検索",
      description:
        "Akashic のアセット (画像・動画・ブログ本文・トークなど) を全文検索する。" +
        "本文・タイトル・OCR・書き起こしが対象。返る id は akashic_get_asset / akashic_update_asset にそのまま渡せる。",
      inputSchema: z.object({
        q: z
          .string()
          .describe(
            "検索語。**空白では分割されない**（「坂井新奈 渋谷」は 1 つの語として扱われる）。" +
              "複数語を OR 検索したいときは「坂井新奈/渋谷」のようにスラッシュで区切る。" +
              "URL を渡すとその URL に一致するアセットを探す。"
          ),
        target: z
          .enum(["all", "assets", "texts"])
          .optional()
          .describe("既定は all。texts にすると本文のみを検索する"),
        kinds: z
          .array(z.enum(ASSET_KINDS))
          .optional()
          .describe("アセット種別で絞る (複数指定は OR)"),
        status: z.enum(ASSET_STATUSES).optional(),
        trustLevel: z.enum(TRUST_LEVELS).optional(),
        sourceType: z.enum(SOURCE_TYPES).optional(),
        entityNames: z
          .array(z.string())
          .optional()
          .describe("この名前のエンティティ (人物・タグ・聖地) が紐づくアセットに絞る"),
        entityMatch: z
          .enum(["any", "all"])
          .optional()
          .describe("entityNames の結合方法。既定は any (いずれかを含む)"),
        dateFrom: DATE_ONLY.optional().describe("公開日/放送日の下限 (JST)"),
        dateTo: DATE_ONLY.optional().describe("公開日/放送日の上限 (JST)"),
        page: z.number().int().min(1).optional(),
        perPage: z.number().int().min(1).max(50).optional().describe("既定 20、最大 50"),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      let entityIds: string[] | undefined;
      let hint: string | undefined;

      if (args.entityNames && args.entityNames.length > 0) {
        const resolution = await resolveEntityNames(args.entityNames, {
          clearance: user.clearance,
        });
        hint = entityResolutionHint(resolution);
        entityIds = resolution.resolved.map((e) => e.id);

        if (entityIds.length === 0) {
          // 名前が 1 つも解決できていない状態で絞り込みを外すと、
          // 「絞ったつもりの結果」を返してしまうので空で返す。
          // 空白のみの名前は resolveEntityNames が捨てるため hint が出ない。理由なしの 0 件を避ける
          return ok({
            total: 0,
            page: args.page ?? 1,
            perPage: args.perPage ?? 20,
            items: [],
            hint:
              hint ??
              "entityNames に有効な名前がありません。空文字や空白のみの要素を除いて指定し直してください。",
          });
        }
      }

      const query: SearchQuery = {
        q: args.q,
        target: args.target ?? "all",
        kinds: args.kinds as AssetKind[] | undefined,
        status: args.status as AssetStatus | undefined,
        trustLevel: args.trustLevel as TrustLevel | undefined,
        sourceType: args.sourceType as SourceType | undefined,
        entityIds,
        entityMatch: args.entityMatch,
        dateFrom: args.dateFrom ? parseDateOnly(args.dateFrom) ?? undefined : undefined,
        dateTo: args.dateTo ? parseDateOnly(args.dateTo) ?? undefined : undefined,
        page: args.page ?? 1,
        perPage: args.perPage ?? 20,
      };

      try {
        const result = await search(query, user.clearance);

        return ok({
          total: result.total,
          page: result.page,
          perPage: result.perPage,
          items: result.items.map((item) => toSearchItem(item, baseUrl)),
          ...(hint ? { hint } : {}),
        });
      } catch (err) {
        return toToolError(err, "検索に失敗しました。");
      }
    }
  );

  server.registerTool(
    "akashic_get_asset",
    {
      title: "アセット詳細取得",
      description:
        "アセット 1 件の詳細を取得する。本文 (テキスト)、紐づくエンティティ、出典レコードを含む。" +
        "本文が長い場合は先頭 4000 文字までに切り詰められる。",
      inputSchema: z.object({
        id: z.string().describe("アセット ID (akashic_search が返す id)"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const asset = await getAsset(id, user.clearance);
      if (!asset) {
        return fail(
          "アセットが見つかりません。ID が誤っているか、クリアランスが足りず参照できません。",
          { id }
        );
      }
      return ok(toAssetDetail(asset, baseUrl));
    }
  );

  server.registerTool(
    "akashic_list_entities",
    {
      title: "エンティティ検索",
      description:
        "人物 (メンバー)・聖地・タグ・番組などのエンティティを検索する。" +
        "アセット登録時に entityNames へ渡す正式名称を確かめるときに使う。",
      inputSchema: z.object({
        q: z
          .string()
          .optional()
          .describe(
            "部分一致で絞る。省略すると全体をページングして返す。" +
              "q を指定した場合はページングが効かず、上位 perPage 件までを返す (総件数は分からない)"
          ),
        type: z
          .enum(ENTITY_TYPES)
          .optional()
          .describe("person=メンバー等の人物 / place=聖地 / tag=タグ / event=イベント / source=情報源"),
        page: z.number().int().min(1).optional().describe("q 省略時のみ有効"),
        perPage: z.number().int().min(1).max(100).optional().describe("既定 20、最大 100"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ q, type, page, perPage }) => {
      const limit = perPage ?? DEFAULT_PER_PAGE;

      if (q && q.trim()) {
        // searchEntities は総件数を数えないので total は返さない (打ち切り後の件数を
        // total と称すると、AI が「これで全部」と誤認する)
        const items = await searchEntities(
          q.trim(),
          type as EntityType | undefined,
          limit,
          user.clearance
        );
        return ok({
          returned: items.length,
          perPage: limit,
          hasMore: items.length === limit,
          items: items.map(toEntitySummary),
        });
      }

      const result = await listEntities(
        type as EntityType | undefined,
        page ?? 1,
        limit,
        user.clearance
      );
      return ok({
        total: result.total,
        page: page ?? 1,
        perPage: limit,
        items: result.items.map(toEntitySummary),
      });
    }
  );

  server.registerTool(
    "akashic_list_places",
    {
      title: "聖地一覧",
      description:
        "登録済みの聖地 (ロケ地・訪問先) を一覧する。緯度経度・住所・Google Maps URL を含む。" +
        "同じ場所を二重登録しないよう、akashic_create_place の前に必ず確認する。",
      inputSchema: z.object({
        q: z.string().optional().describe("聖地名の部分一致で絞る"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ q }) => {
      const places = await listPlaces(user.clearance);
      const needle = q?.trim() ? normalizeText(q.trim()) : null;
      const filtered = needle
        ? places.filter((p) => normalizeText(p.entity.canonicalName).includes(needle))
        : places;

      return ok({
        total: filtered.length,
        items: filtered.map((p) => toPlaceSummary(p, baseUrl)),
      });
    }
  );
}

// ------------------------------------------------------------
// 書き込み
// ------------------------------------------------------------

function registerWriteTools(server: McpServer, { user, baseUrl }: ToolContext) {
  server.registerTool(
    "akashic_create_asset",
    {
      title: "アセットの下書き登録",
      description:
        "アセットを新規登録する。status は必ず inbox になり、人間が /inbox で仕分けする前提の下書きとして入る。" +
        "エンティティは名前で指定でき、既存に一致したものだけが紐づく " +
        "(一致しない名前は unresolvedEntities として返る)。",
      inputSchema: z.object({
        kind: z.enum(ASSET_KINDS).describe("アセット種別。Discord のテキスト投稿なら text"),
        title: z.string().describe("タイトル。一覧で識別できる短い日本語"),
        description: z.string().optional(),
        bodyText: z.string().optional().describe("本文。AssetText(body) として保存される"),
        canonicalDate: DATE_ONLY.optional().describe("公開日・放送日 (JST)。投稿日ではなく内容の日付"),
        trustLevel: z.enum(TRUST_LEVELS).optional().describe("既定は unverified"),
        sourceType: z
          .enum(SOURCE_TYPES)
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
          .enum(CLEARANCE_LEVELS)
          .optional()
          .describe("機密レベル。既定は internal。自分のクリアランスより上は指定できない"),
        discordGuildId: z.string().optional(),
        discordChannelId: z.string().optional(),
        discordMessageId: z.string().optional(),
        discordMessageUrl: z.string().optional().describe("Discord メッセージへのリンク"),
        discordAuthorId: z.string().optional(),
        discordAuthorName: z.string().optional().describe("Discord 投稿者の表示名"),
        discordPostedAt: z.string().optional().describe("Discord 投稿日時 (ISO 8601)"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const classification = (args.classification ?? "internal") as ClearanceLevel;
      try {
        assertClearance(user.clearance, classification);
      } catch {
        return fail(
          `クリアランス (${user.clearance}) を超える classification (${classification}) は指定できません。`
        );
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
      const sourceType = (args.sourceType ?? (hasDiscord ? "discord" : "manual")) as SourceType;

      let discordPostedAt: Date | null = null;
      if (args.discordPostedAt) {
        const parsed = new Date(args.discordPostedAt);
        if (isNaN(parsed.getTime())) {
          return fail("discordPostedAt が日時として解釈できません (ISO 8601 で指定してください)。", {
            discordPostedAt: args.discordPostedAt,
          });
        }
        discordPostedAt = parsed;
      }

      try {
        const asset = await intakeAsset(
          {
            kind: args.kind as AssetKind,
            classification,
            title: args.title,
            description: args.description,
            // MCP 経由の作成は必ず仕分け待ちに入れる
            status: "inbox",
            trustLevel: args.trustLevel as TrustLevel | undefined,
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
              ? [{ textType: "body" as TextType, content: args.bodyText.trim() }]
              : undefined,
            entities: resolution?.resolved.map((e) => ({ entityId: e.id })),
            sourceRecords: args.sourceUrl
              ? [{ sourceKind: "url" as const, title: args.title, url: args.sourceUrl }]
              : undefined,
          },
          user.id,
          user.clearance
        );

        await logMcpToolCall({
          user,
          tool: "create_asset",
          targetType: "Asset",
          targetId: asset.id,
          args: { kind: args.kind, title: args.title, sourceType },
        });

        const hint = resolution ? entityResolutionHint(resolution) : undefined;

        return ok({
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
        });
      } catch (err) {
        return toToolError(err, "アセットの作成に失敗しました。");
      }
    }
  );

  server.registerTool(
    "akashic_update_asset",
    {
      title: "アセット更新",
      description:
        "既存アセットのメタデータ・ステータス・本文を更新する。" +
        "本文は upsertTexts で textType 単位に上書きする (指定しない textType は残る)。" +
        "エンティティは追加のみで、既存の紐づけは外れない。",
      inputSchema: z.object({
        id: z.string().describe("アセット ID"),
        title: z.string().optional(),
        description: z.string().optional(),
        status: z
          .enum(ASSET_STATUSES)
          .optional()
          .describe("inbox=仕分け待ち / triaging=仕分け中 / organized=整理済み / archived=保管"),
        trustLevel: z.enum(TRUST_LEVELS).optional(),
        canonicalDate: DATE_ONLY.optional().describe("公開日・放送日 (JST)"),
        classification: z
          .enum(CLEARANCE_LEVELS)
          .optional()
          .describe(
            "機密レベル。**引き上げのみ可能**で、現在より低い値を指定するとエラーになる " +
              "(引き下げは画面から人間が行う)。自分のクリアランスより上も指定できない"
          ),
        upsertTexts: z
          .array(
            z.object({
              textType: z.enum(TEXT_TYPES),
              content: z.string(),
              language: z.string().optional(),
            })
          )
          .optional()
          .describe("指定した textType のテキストを置き換える。他の textType は保持される"),
        entityNames: z.array(z.string()).optional().describe("追加で紐づけたいエンティティ名"),
        createMissingEntities: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      if (args.classification) {
        try {
          assertClearance(user.clearance, args.classification as ClearanceLevel);
        } catch {
          return fail(
            `クリアランス (${user.clearance}) を超える classification (${args.classification}) は指定できません。`
          );
        }
      }

      const existing = await getAsset(args.id, user.clearance);
      if (!existing) {
        return fail(
          "アセットが見つかりません。ID が誤っているか、クリアランスが足りず参照できません。",
          { id: args.id }
        );
      }

      const downgradeA = rejectClassificationDowngrade(
        existing.classification,
        args.classification
      );
      if (downgradeA) return downgradeA;

      const resolution = args.entityNames?.length
        ? await resolveEntityNames(args.entityNames, {
            createMissing: args.createMissingEntities,
            clearance: user.clearance,
          })
        : null;

      try {
        const asset = await updateAsset(
          args.id,
          {
            title: args.title,
            description: args.description,
            status: args.status as AssetStatus | undefined,
            trustLevel: args.trustLevel as TrustLevel | undefined,
            canonicalDate: args.canonicalDate ? parseDateOnly(args.canonicalDate) : undefined,
            classification: args.classification as ClearanceLevel | undefined,
            upsertTexts: args.upsertTexts?.map((t) => ({
              textType: t.textType as TextType,
              content: t.content,
              language: t.language,
            })),
            entities: resolution?.resolved.map((e) => ({ entityId: e.id })),
          },
          user.id,
          user.clearance
        );

        invalidateAssets();

        await logMcpToolCall({
          user,
          tool: "update_asset",
          targetType: "Asset",
          targetId: args.id,
          args: {
            updatedFields: Object.keys(args)
              .filter((k) => k !== "id")
              .join(","),
          },
        });

        const hint = resolution ? entityResolutionHint(resolution) : undefined;

        return ok({
          ...toAssetDetail(asset, baseUrl),
          ...(resolution?.created.length ? { createdEntities: resolution.created } : {}),
          ...(resolution?.unresolved.length ? { unresolvedEntities: resolution.unresolved } : {}),
          ...(resolution?.ambiguous.length ? { ambiguousEntities: resolution.ambiguous } : {}),
          ...(hint ? { hint } : {}),
        });
      } catch (err) {
        return toToolError(err, "アセットの更新に失敗しました。");
      }
    }
  );

  server.registerTool(
    "akashic_create_place",
    {
      title: "聖地登録",
      description:
        "聖地 (ロケ地・訪問先) を新規登録する。googleMapsUrl を渡せば短縮 URL を展開して緯度経度と地点名を取り出す。" +
        "緯度経度を直接渡してもよい。登録前に akashic_list_places で重複を確認すること。",
      inputSchema: z.object({
        googleMapsUrl: z
          .string()
          .url()
          .optional()
          .describe("Google Maps の URL。maps.app.goo.gl の短縮 URL も可"),
        name: z
          .string()
          .optional()
          .describe("聖地名。省略時は googleMapsUrl から取れた地点名を使う"),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        address: z.string().optional(),
        description: z.string().optional().describe("何の聖地かの説明 (出演回・エピソード等)"),
        aliases: z.array(z.string()).optional().describe("別名・通称"),
        classification: z
          .enum(CLEARANCE_LEVELS)
          .optional()
          .describe("既定は internal。自分のクリアランスより上は指定できない"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const classification = (args.classification ?? "internal") as ClearanceLevel;
      try {
        assertClearance(user.clearance, classification);
      } catch {
        return fail(
          `クリアランス (${user.clearance}) を超える classification (${classification}) は指定できません。`
        );
      }

      let latitude = args.latitude;
      let longitude = args.longitude;
      let name = args.name?.trim();
      let googleMapsUrl = args.googleMapsUrl;

      if (args.googleMapsUrl && (latitude == null || longitude == null || !name)) {
        const resolved = await resolveGoogleMapsUrl(args.googleMapsUrl);
        if (!resolved.ok) {
          // 座標が別途渡っていれば no_coordinates は許容する (URL は出典として保存するだけ)
          const coordsGivenDirectly = latitude != null && longitude != null;
          if (resolved.error !== "no_coordinates" || !coordsGivenDirectly) {
            return failResolveUrl(resolved.error, args.googleMapsUrl, resolved.expanded);
          }
        } else {
          latitude = latitude ?? resolved.lat;
          longitude = longitude ?? resolved.lng;
          if (!name && resolved.name) name = resolved.name;
          googleMapsUrl = resolved.googleMapsUrl;
        }
      }

      if (!name) {
        return fail("聖地名が決まりません。name を指定してください。");
      }
      if (latitude == null || longitude == null) {
        return fail("緯度経度が決まりません。googleMapsUrl か latitude / longitude を指定してください。");
      }

      // Place.entityId は unique なので、同名エンティティに既に Place があると作成が失敗する。
      // Place は RLS 対象なので withClearance を通す (素の prisma だと無言で 0 行になり、
      // 重複チェックをすり抜けて Prisma の一意制約エラーになる)。
      const existingPlace = await withClearance(user.clearance, (tx) =>
        tx.place.findFirst({
          where: { entity: { type: "place", canonicalName: name } },
          select: { id: true },
        })
      );
      if (existingPlace) {
        return fail("同名の聖地が既に登録されています。akashic_update_place で更新してください。", {
          existingPlaceId: existingPlace.id,
          name,
        });
      }

      try {
        const place = await createPlace(
          {
            canonicalName: name,
            latitude,
            longitude,
            googleMapsUrl,
            address: args.address,
            description: args.description,
            aliases: args.aliases,
            classification,
          },
          user.clearance
        );

        invalidatePlaces();

        await logMcpToolCall({
          user,
          tool: "create_place",
          targetType: "Place",
          targetId: place.id,
          args: { name, latitude, longitude },
        });

        return ok(toPlaceSummary(place, baseUrl));
      } catch (err) {
        return toToolError(err, "聖地の登録に失敗しました。");
      }
    }
  );

  server.registerTool(
    "akashic_update_place",
    {
      title: "聖地更新",
      description:
        "登録済みの聖地を更新する。googleMapsUrl だけ渡した場合は、そこから緯度経度を取り直して更新する。",
      inputSchema: z.object({
        id: z.string().describe("聖地 ID (akashic_list_places が返す id)"),
        name: z.string().optional(),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        googleMapsUrl: z.string().url().optional(),
        address: z.string().optional(),
        description: z.string().optional(),
        classification: z
          .enum(CLEARANCE_LEVELS)
          .optional()
          .describe(
            "機密レベル。**引き上げのみ可能**で、現在より低い値を指定するとエラーになる " +
              "(引き下げは画面から人間が行う)。自分のクリアランスより上も指定できない"
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      if (args.classification) {
        try {
          assertClearance(user.clearance, args.classification as ClearanceLevel);
        } catch {
          return fail(
            `クリアランス (${user.clearance}) を超える classification (${args.classification}) は指定できません。`
          );
        }
      }

      const existing = await getPlaceById(args.id, user.clearance);
      if (!existing) {
        return fail(
          "聖地が見つかりません。ID が誤っているか、クリアランスが足りず参照できません。",
          { id: args.id }
        );
      }

      const downgradeP = rejectClassificationDowngrade(
        existing.classification,
        args.classification
      );
      if (downgradeP) return downgradeP;

      let latitude = args.latitude;
      let longitude = args.longitude;
      let googleMapsUrl = args.googleMapsUrl;

      if (args.googleMapsUrl && (latitude == null || longitude == null)) {
        const resolved = await resolveGoogleMapsUrl(args.googleMapsUrl);
        if (!resolved.ok) {
          // ここで素通しすると URL だけ新しい場所に差し替わり、座標が古いまま残る
          return failResolveUrl(resolved.error, args.googleMapsUrl, resolved.expanded);
        }
        latitude = latitude ?? resolved.lat;
        longitude = longitude ?? resolved.lng;
        googleMapsUrl = resolved.googleMapsUrl;
      }

      try {
        const place = await updatePlace(
          args.id,
          {
            canonicalName: args.name,
            latitude,
            longitude,
            googleMapsUrl,
            address: args.address,
            description: args.description,
            classification: args.classification as ClearanceLevel | undefined,
          },
          user.clearance
        );

        invalidatePlaces();

        await logMcpToolCall({
          user,
          tool: "update_place",
          targetType: "Place",
          targetId: args.id,
          args: {
            updatedFields: Object.keys(args)
              .filter((k) => k !== "id")
              .join(","),
          },
        });

        return ok(toPlaceSummary(place, baseUrl));
      } catch (err) {
        return toToolError(err, "聖地の更新に失敗しました。");
      }
    }
  );
}
