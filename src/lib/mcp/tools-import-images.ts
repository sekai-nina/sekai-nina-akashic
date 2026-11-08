import { createHash } from "node:crypto";
import { Prisma, type $Enums } from "@prisma/client";
import sharp from "sharp";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ApiKeyUser } from "@/lib/api-auth";
import { mapWithConcurrency } from "@/lib/async";
import { isAboveClearance, isClassificationDowngrade } from "@/lib/classification";
import { withClearance } from "@/lib/db";
import { intakeAsset } from "@/lib/domain/asset-intake";
import { logAudit } from "@/lib/domain/audit";
import { isDriveEnabled, trashDriveFile, uploadToDrive } from "@/lib/drive";
import { safeFetch, SafeFetchError } from "@/lib/net/safe-fetch";
import { attachR2Thumbnail, findDuplicateVisibleFirst } from "./asset-files";
import { ASSET_DRAFT_FIELDS, entityResolutionPayload, prepareAssetDraft } from "./asset-input";
import { logMcpToolCall } from "./audit";
import { assetUrl } from "./format";
import { filenameFromUrl, IMAGE_FORMATS_LABEL, imageTypeOf, toHeaderSafeUrl } from "./image-import";
import { fail, ok, toToolError } from "./result";
import type { ToolContext } from "./tools";

/**
 * 画像 URL をサーバーが取りに行ってアセットにする MCP ツール (#385)。
 *
 * akashic_begin_upload / complete_upload は「手元で curl を叩ける」エージェント向けで、
 * シェルを持たないふぃたんには使えない。こちらは URL を渡すだけで、取得 → Drive → アセット登録 →
 * サムネイル → 親アセットの子としてつなぐ、までをその場で終わらせて 1 枚ずつの成否を返す。
 *
 * - URL は https の公開 URL ならどこでも取る。内部向けアドレスは safeFetch が拒む (SSRF)
 * - 中身は sharp で画像として読めるものだけ通す (エラーページの HTML を画像として残さない)
 * - sha256 が既存と一致したら作らずに既存を子としてつなぐ (既存の中身は書き換えない)
 */

/** 1 回で受ける枚数。MCP の関数は 300 秒で切れる (route の maxDuration) ので抑える */
const MAX_IMAGES = 20;
/** 同時に取りに行く枚数 */
const CONCURRENCY = 4;
/** 1 枚の上限 */
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
/** 1 枚の取得 (リダイレクト込み) の上限 */
const FETCH_TIMEOUT_MS = 30_000;
/**
 * これを過ぎたら新しい画像に取りかからず skipped で返す。300 秒で切られると結果が 1 枚も返らないので、
 * 取りかかり中の 1 枚 (取得 30 秒 + Drive・登録・サムネイル) が終わる余裕を残す
 */
const START_DEADLINE_MS = 200_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

type LinkOutcome = "linked" | "already_linked" | "cycle";

type ImageResult = { index: number; imageUrl: string; position?: number } & (
  | { status: "created"; id: string; title: string; url: string; link?: LinkOutcome | "link_failed" }
  | { status: "duplicate"; id: string; title: string; url: string; link?: LinkOutcome | "link_failed" }
  | { status: "duplicate_hidden" }
  | { status: "failed"; error: string }
  | { status: "skipped" }
);

/**
 * 親の子につなぐ。既につながっていれば何もしない。
 * 監査ログは domain の createAssetRelation と同じ action で残す (あちらは既存なら投げるので使わない)
 */
async function linkChild(
  user: ApiKeyUser,
  parentId: string,
  childId: string,
  sortOrder: number,
  imageUrl: string
): Promise<LinkOutcome> {
  if (parentId === childId) return "cycle";
  const key = { sourceId: parentId, targetId: childId, relationType: "parent_child" as const };
  const outcome = await withClearance(user.clearance, async (tx) => {
    const existing = await tx.assetRelation.findUnique({ where: { sourceId_targetId_relationType: key } });
    if (existing) return { kind: "already_linked" as const };
    // 逆向き (子が親の親) なら循環になるのでつながない (createAssetRelation と同じく 1 段だけ見る)
    const reverse = await tx.assetRelation.findUnique({
      where: {
        sourceId_targetId_relationType: { sourceId: childId, targetId: parentId, relationType: "parent_child" },
      },
    });
    if (reverse) return { kind: "cycle" as const };
    try {
      const relation = await tx.assetRelation.create({
        data: { ...key, sortOrder, metadata: { source: "mcp_import_images", url: imageUrl } },
      });
      return { kind: "linked" as const, relationId: relation.id };
    } catch (err) {
      // 並行する呼び出しが先につないだ
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return { kind: "already_linked" as const };
      }
      throw err;
    }
  });
  if (outcome.kind === "linked") {
    await logAudit({
      actorId: user.id,
      action: "asset_relation.create",
      targetType: "AssetRelation",
      targetId: outcome.relationId,
      metadata: { ...key, via: "mcp.import_images" },
    });
  }
  return outcome.kind;
}

/** つなぐのに失敗しても、作ったアセットは created のまま返す (失敗扱いにすると取り直しで迷う) */
async function tryLinkChild(...args: Parameters<typeof linkChild>): Promise<LinkOutcome | "link_failed"> {
  try {
    return await linkChild(...args);
  } catch (err) {
    console.error("[mcp] import_images: 親につなげませんでした:", err);
    return "link_failed";
  }
}

export function registerImportImageTools(server: McpServer, { user, baseUrl }: ToolContext) {
  server.registerTool(
    "akashic_import_images",
    {
      title: "画像 URL の取り込み",
      description:
        "画像の URL を渡すと、サーバーが取得して Drive に保存し、アセット (status: inbox) として登録する。" +
        `1 回 ${MAX_IMAGES} 枚まで。多いときは分けて、前の呼び出しが返ってから次を呼ぶ (並行に呼ぶと並び順が重なる)。` +
        "parentAssetId を渡すと、その子として並べる。並び順は images[].position (1 始まり) で、" +
        "省略すると既存の子の後ろに渡した順で続く。取り直しのときは元の position を渡す。" +
        "メタデータは akashic_create_asset と同じで全枚共通。title は images[].title が無ければ「共通 title #position」になる。" +
        "同じ画像が既にあれば新しく作らず、既存を子としてつなぐ (status: duplicate)。" +
        "sourceUrl には画像が載っていたページの URL を渡す (無ければ画像 URL を出典にする)。",
      inputSchema: z.object({
        images: z
          .array(
            z.object({
              url: z.string().url().describe("画像の URL (https)"),
              title: z.string().optional().describe("この画像だけのタイトル"),
              position: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe("親の子の中での並び順 (1 始まり)。雑誌のページ順などを固定したいとき・取り直しのときに渡す"),
            })
          )
          .min(1)
          .max(MAX_IMAGES),
        parentAssetId: z.string().optional().describe("子としてつなぐ親アセットの ID"),
        ...ASSET_DRAFT_FIELDS,
        classification: ASSET_DRAFT_FIELDS.classification.describe(
          "機密レベル。省略時は親の classification、親が無ければ internal。" +
            "自分のクリアランスより上と、親より下は指定できない"
        ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const startedAt = Date.now();
      try {
        if (!isDriveEnabled()) {
          return fail("Google Drive が未設定のため、画像を取り込めません。");
        }

        // 親が見えるかと、子の並び順の続き番号
        let parent: { id: string; title: string; classification: $Enums.ClearanceLevel } | null = null;
        let startSortOrder = 0;
        if (args.parentAssetId) {
          const found = await withClearance(user.clearance, async (tx) => {
            const asset = await tx.asset.findUnique({
              where: { id: args.parentAssetId },
              select: { id: true, title: true, classification: true },
            });
            if (!asset) return null;
            const last = await tx.assetRelation.aggregate({
              where: { sourceId: asset.id, relationType: "parent_child" },
              _max: { sortOrder: true },
              _count: true,
            });
            return { asset, next: last._count > 0 ? (last._max.sortOrder ?? 0) + 1 : 0 };
          });
          if (!found) {
            return fail("parentAssetId のアセットが見つかりません。", { parentAssetId: args.parentAssetId });
          }
          parent = found.asset;
          startSortOrder = found.next;
        }

        // 子を親より下の機密レベルで作らせない (取り込み先のページに仕込まれた指示で、
        // 機密の雑誌のページを public で作らせる、を止める)。引き下げは画面から人間が行う
        if (parent && args.classification && isClassificationDowngrade(parent.classification, args.classification)) {
          return fail(
            `親 (${parent.classification}) より下の classification (${args.classification}) では作れません。` +
              "classification を省略すると親と同じになります。"
          );
        }
        const classification = args.classification ?? parent?.classification ?? "internal";
        const prepared = await prepareAssetDraft({ ...args, classification }, user);
        if ("error" in prepared) return prepared.error;
        const { data, resolution } = prepared.draft;

        // 直リンク対策で Referer を見るサイトがあるので、載っていたページを名乗る
        const referer = args.sourceUrl ? toHeaderSafeUrl(args.sourceUrl) : null;

        // 同じ呼び出しの中で同じ画像が 2 回来たら 2 つ目は作らない (並行処理で重複判定をすり抜けるため)
        const seen = new Map<string, number>();

        const results = await mapWithConcurrency(args.images, CONCURRENCY, async (image, index): Promise<ImageResult> => {
          const sortOrder = image.position != null ? image.position - 1 : startSortOrder + index;
          // 取り直しで同じ位置に戻せるよう、親があれば position を返す
          const base = { index, imageUrl: image.url, ...(parent ? { position: sortOrder + 1 } : {}) };
          if (Date.now() - startedAt > START_DEADLINE_MS) return { ...base, status: "skipped" };

          const title = image.title?.trim() || `${args.title} #${sortOrder + 1}`;
          try {
            const fetched = await safeFetch(image.url, {
              maxBytes: MAX_IMAGE_BYTES,
              timeoutMs: FETCH_TIMEOUT_MS,
              headers: {
                "User-Agent": USER_AGENT,
                Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
                ...(referer ? { Referer: referer } : {}),
              },
            });

            const meta = await sharp(fetched.body)
              .metadata()
              .catch(() => null);
            if (!meta) return { ...base, status: "failed", error: "画像として読めませんでした" };
            const type = imageTypeOf(meta);
            if (!type) return { ...base, status: "failed", error: `対応していない形式です (${IMAGE_FORMATS_LABEL})` };

            const sha256 = createHash("sha256").update(fetched.body).digest("hex");
            const earlier = seen.get(sha256);
            if (earlier !== undefined) {
              return { ...base, status: "failed", error: `images[${earlier}] と同じ画像です (2 つ目は取り込みません)` };
            }
            seen.set(sha256, index);

            const dup = await findDuplicateVisibleFirst(sha256, user.clearance);
            if (dup) {
              if (isAboveClearance(dup.classification, user.clearance)) {
                return { ...base, status: "duplicate_hidden" };
              }
              const link = parent ? await tryLinkChild(user, parent.id, dup.id, sortOrder, image.url) : undefined;
              if (link === "linked") {
                await logMcpToolCall({
                  user,
                  tool: "import_images",
                  targetType: "Asset",
                  targetId: dup.id,
                  args: { url: image.url, duplicate: true, parentAssetId: parent?.id, sha256 },
                });
              }
              return {
                ...base,
                status: "duplicate",
                id: dup.id,
                title: dup.title,
                url: assetUrl(baseUrl, dup.id),
                ...(link ? { link } : {}),
              };
            }

            const filename = filenameFromUrl(fetched.finalUrl, type.ext, sha256);
            const uploaded = await uploadToDrive(fetched.body, filename, type.mimeType);
            if (!uploaded) return { ...base, status: "failed", error: "Drive に保存できませんでした" };

            const asset = await intakeAsset(
              {
                ...data,
                title,
                kind: "image",
                storageProvider: "gdrive",
                storageUrl: uploaded.webViewLink,
                storageKey: uploaded.fileId,
                sha256,
                originalFilename: filename,
                mimeType: type.mimeType,
                fileSize: fetched.body.length,
                thumbnailUrl: uploaded.webViewLink,
                // prepareAssetDraft が sourceUrl から組んだものを、画像ごとのタイトルで作り直す
                sourceRecords: [{ sourceKind: "url" as const, title, url: args.sourceUrl ?? image.url }],
              },
              user.id,
              user.clearance
            ).catch(async (err) => {
              // アセットにならなかった実体は Drive に残さない (ゴミ箱なので 30 日は戻せる)
              await trashDriveFile(uploaded.fileId).catch((e) => console.warn("[mcp] 孤児ファイルの片付けに失敗:", e));
              throw err;
            });

            // 監査ログはサムネイルより先に書く (サムネイルで落ちても作成の記録は残す)
            await logMcpToolCall({
              user,
              tool: "import_images",
              targetType: "Asset",
              targetId: asset.id,
              args: { url: image.url, title, parentAssetId: parent?.id, sha256, sourceType: data.sourceType },
            });

            await attachR2Thumbnail(asset.id, fetched.body, user.clearance);

            const link = parent ? await tryLinkChild(user, parent.id, asset.id, sortOrder, image.url) : undefined;

            return {
              ...base,
              status: "created",
              id: asset.id,
              title,
              url: assetUrl(baseUrl, asset.id),
              ...(link ? { link } : {}),
            };
          } catch (err) {
            if (err instanceof SafeFetchError) return { ...base, status: "failed", error: err.message };
            console.error("[mcp] import_images:", image.url, err);
            return { ...base, status: "failed", error: "取り込みに失敗しました" };
          }
        });

        const count = (s: ImageResult["status"]) => results.filter((r) => r.status === s).length;
        const retry = count("failed") + count("skipped");
        return ok({
          ...(parent ? { parent: { id: parent.id, title: parent.title, url: assetUrl(baseUrl, parent.id) } } : {}),
          classification,
          summary: {
            created: count("created"),
            duplicate: count("duplicate"),
            duplicateHidden: count("duplicate_hidden"),
            failed: count("failed"),
            skipped: count("skipped"),
          },
          results,
          ...entityResolutionPayload(resolution),
          ...(retry
            ? {
                next:
                  "failed は error を見て URL を直すか取り直し、skipped (時間切れで手を付けなかった分) はそのまま、" +
                  "その分だけを同じ引数で呼び直してください。並び順を保つなら元の position (1 始まり) を images[].position に渡します。",
              }
            : {}),
        });
      } catch (err) {
        return toToolError(err, "画像の取り込みに失敗しました。");
      }
    }
  );
}
