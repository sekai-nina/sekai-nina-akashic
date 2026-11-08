import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ApiKeyUser } from "@/lib/api-auth";
import { isAboveClearance } from "@/lib/classification";
import { withClearance } from "@/lib/db";
import { intakeAsset } from "@/lib/domain/asset-intake";
import { isDriveEnabled, trashDriveFile, uploadToDrive } from "@/lib/drive";
import { safeFetch, SafeFetchError } from "@/lib/net/safe-fetch";
import { generateAndUploadThumbnails } from "@/lib/thumbnails";
import { ASSET_DRAFT_FIELDS, prepareAssetDraft } from "./asset-input";
import { logMcpToolCall } from "./audit";
import { entityResolutionHint } from "./entity-resolution";
import { fail, ok, toToolError } from "./result";
import { findDuplicate } from "./tools-upload";
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

/** 1 回で受ける枚数。Vercel の関数は 300 秒で切れるので、余裕を持って抑える */
const MAX_IMAGES = 20;
/** 同時に取りに行く枚数 */
const CONCURRENCY = 4;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** sharp の format → MIME と拡張子。SVG はスクリプトを含められるので受けない */
function imageTypeOf(meta: sharp.Metadata): { mimeType: string; ext: string } | null {
  switch (meta.format) {
    case "jpeg":
      return { mimeType: "image/jpeg", ext: "jpg" };
    case "png":
      return { mimeType: "image/png", ext: "png" };
    case "webp":
      return { mimeType: "image/webp", ext: "webp" };
    case "gif":
      return { mimeType: "image/gif", ext: "gif" };
    case "tiff":
      return { mimeType: "image/tiff", ext: "tiff" };
    case "heif":
      return meta.compression === "av1"
        ? { mimeType: "image/avif", ext: "avif" }
        : { mimeType: "image/heic", ext: "heic" };
    default:
      return null;
  }
}

/** Drive 上のファイル名。URL の末尾を使い、拡張子は中身に合わせる */
export function filenameFromUrl(url: string, ext: string, sha256: string): string {
  let base = "";
  try {
    base = decodeURIComponent(path.posix.basename(new URL(url).pathname));
  } catch {
    // 不正なエスケープは捨てる
  }
  base = base.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 100);
  return `${base || sha256.slice(0, 16)}.${ext}`;
}

type ImageResult =
  | { index: number; url: string; status: "created"; id: string; title: string; assetUrl: string }
  | { index: number; url: string; status: "duplicate"; id: string; title: string; assetUrl: string; linked: boolean }
  | { index: number; url: string; status: "duplicate_hidden" }
  | { index: number; url: string; status: "failed"; error: string };

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    })
  );
  return results;
}

/** 親の子につなぐ。既につながっていれば何もしない。つないだら true */
async function linkChild(
  user: ApiKeyUser,
  parentId: string,
  childId: string,
  sortOrder: number,
  sourceUrl: string
): Promise<boolean> {
  if (parentId === childId) return false;
  return withClearance(user.clearance, async (tx) => {
    const key = { sourceId: parentId, targetId: childId, relationType: "parent_child" as const };
    const existing = await tx.assetRelation.findUnique({ where: { sourceId_targetId_relationType: key } });
    if (existing) return false;
    // 逆向き (子が親の親) なら循環になるのでつながない
    const reverse = await tx.assetRelation.findUnique({
      where: {
        sourceId_targetId_relationType: { sourceId: childId, targetId: parentId, relationType: "parent_child" },
      },
    });
    if (reverse) return false;
    await tx.assetRelation.create({
      data: { ...key, sortOrder, metadata: { source: "mcp_import_images", url: sourceUrl } },
    });
    return true;
  });
}

export function registerImportImageTools(server: McpServer, { user, baseUrl }: ToolContext) {
  server.registerTool(
    "akashic_import_images",
    {
      title: "画像 URL の取り込み",
      description:
        "画像の URL を渡すと、サーバーが取得して Drive に保存し、アセット (status: inbox) として登録する。" +
        `1 回 ${MAX_IMAGES} 枚まで。多いときは分けて呼ぶ。` +
        "parentAssetId を渡すと、その子として渡した順に並べる (雑誌記事のグラビア画像など)。" +
        "メタデータは akashic_create_asset と同じで全枚共通。title は images[].title が無ければ「共通 title #番号」になる。" +
        "同じ画像が既にあれば新しく作らず、既存を子としてつなぐ (status: duplicate)。" +
        "sourceUrl には画像が載っていたページの URL を渡す (無ければ画像 URL を出典にする)。",
      inputSchema: z.object({
        images: z
          .array(
            z.object({
              url: z.string().url().describe("画像の URL (https)"),
              title: z.string().optional().describe("この画像だけのタイトル"),
            })
          )
          .min(1)
          .max(MAX_IMAGES),
        parentAssetId: z.string().optional().describe("子としてつなぐ親アセットの ID"),
        ...ASSET_DRAFT_FIELDS,
        classification: ASSET_DRAFT_FIELDS.classification.describe(
          "機密レベル。省略時は親の classification、親が無ければ internal。自分のクリアランスより上は指定できない"
        ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        if (!isDriveEnabled()) {
          return fail("Google Drive が未設定のため、画像を取り込めません。");
        }

        // 親が見えるかと、子の並び順の続き番号
        let parent: { id: string; title: string; classification: string } | null = null;
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

        const classification = (args.classification ??
          parent?.classification ??
          "internal") as NonNullable<typeof args.classification>;
        const prepared = await prepareAssetDraft({ ...args, classification }, user);
        if ("error" in prepared) return prepared.error;
        const { data, resolution } = prepared.draft;

        // 同じ呼び出しの中で同じ画像が 2 回来たら 2 つ目は作らない (並行処理で重複判定をすり抜けるため)
        const seen = new Map<string, number>();

        const results = await mapWithConcurrency(args.images, CONCURRENCY, async (image, index): Promise<ImageResult> => {
          const sortOrder = startSortOrder + index;
          const title = image.title?.trim() || `${args.title} #${sortOrder + 1}`;
          try {
            const fetched = await safeFetch(image.url, {
              maxBytes: MAX_IMAGE_BYTES,
              timeoutMs: FETCH_TIMEOUT_MS,
              headers: {
                "User-Agent": USER_AGENT,
                Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
                // 直リンク対策で Referer を見るサイトがあるので、載っていたページを名乗る
                ...(args.sourceUrl ? { Referer: args.sourceUrl } : {}),
              },
            });
            const type = imageTypeOf(await sharp(fetched.body).metadata());
            if (!type) {
              return { index, url: image.url, status: "failed", error: "対応していない形式です (JPEG / PNG / WebP / GIF / TIFF / HEIC / AVIF)" };
            }

            const sha256 = createHash("sha256").update(fetched.body).digest("hex");
            const earlier = seen.get(sha256);
            if (earlier !== undefined) {
              return { index, url: image.url, status: "failed", error: `images[${earlier}] と同じ画像です` };
            }
            seen.set(sha256, index);

            const dup = await findDuplicate({ sha256 });
            if (dup) {
              if (isAboveClearance(dup.classification, user.clearance)) {
                return { index, url: image.url, status: "duplicate_hidden" };
              }
              const linked = parent ? await linkChild(user, parent.id, dup.id, sortOrder, image.url) : false;
              return {
                index,
                url: image.url,
                status: "duplicate",
                id: dup.id,
                title: dup.title,
                assetUrl: `${baseUrl}/assets/${dup.id}`,
                linked,
              };
            }

            const filename = filenameFromUrl(fetched.finalUrl, type.ext, sha256);
            const uploaded = await uploadToDrive(fetched.body, filename, type.mimeType);
            if (!uploaded) return { index, url: image.url, status: "failed", error: "Drive に保存できませんでした" };

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
                sourceRecords: [
                  { sourceKind: "url" as const, title, url: args.sourceUrl ?? image.url },
                ],
              },
              user.id,
              user.clearance
            ).catch(async (err) => {
              // アセットにならなかった実体は Drive に残さない (ゴミ箱なので 30 日は戻せる)
              await trashDriveFile(uploaded.fileId).catch((e) => console.warn("[mcp] 孤児ファイルの片付けに失敗:", e));
              throw err;
            });

            await logMcpToolCall({
              user,
              tool: "import_images",
              targetType: "Asset",
              targetId: asset.id,
              args: { url: image.url, title, parentAssetId: parent?.id, sha256 },
            });

            try {
              const r2Url = await generateAndUploadThumbnails(asset.id, fetched.body);
              if (r2Url) {
                await withClearance(user.clearance, (tx) =>
                  tx.asset.update({ where: { id: asset.id }, data: { thumbnailUrl: r2Url } })
                );
              }
            } catch (err) {
              console.error("[mcp] R2 サムネイル生成に失敗:", err);
            }

            if (parent) await linkChild(user, parent.id, asset.id, sortOrder, image.url);

            return { index, url: image.url, status: "created", id: asset.id, title, assetUrl: `${baseUrl}/assets/${asset.id}` };
          } catch (err) {
            const message =
              err instanceof SafeFetchError
                ? err.message
                : err instanceof Error && /unsupported image format|Input buffer/i.test(err.message)
                  ? "画像として読めませんでした"
                  : "取り込みに失敗しました";
            if (!(err instanceof SafeFetchError)) console.error("[mcp] import_images:", image.url, err);
            return { index, url: image.url, status: "failed", error: message };
          }
        });

        const count = (s: ImageResult["status"]) => results.filter((r) => r.status === s).length;
        const hint = resolution ? entityResolutionHint(resolution) : undefined;
        return ok({
          ...(parent ? { parent: { id: parent.id, title: parent.title, url: `${baseUrl}/assets/${parent.id}` } } : {}),
          classification,
          summary: {
            created: count("created"),
            duplicate: count("duplicate"),
            duplicateHidden: count("duplicate_hidden"),
            failed: count("failed"),
          },
          results,
          linkedEntities: resolution?.resolved.map((e) => ({ id: e.id, name: e.name, type: e.type })) ?? [],
          ...(resolution?.created.length ? { createdEntities: resolution.created } : {}),
          ...(resolution?.unresolved.length ? { unresolvedEntities: resolution.unresolved } : {}),
          ...(resolution?.ambiguous.length ? { ambiguousEntities: resolution.ambiguous } : {}),
          ...(hint ? { hint } : {}),
          ...(count("failed")
            ? { next: "failed の画像は error を見て、URL を直すか取り直してから、その分だけ同じ引数で呼び直してください。" }
            : {}),
        });
      } catch (err) {
        return toToolError(err, "画像の取り込みに失敗しました。");
      }
    }
  );
}
