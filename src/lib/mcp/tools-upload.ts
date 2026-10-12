import * as z from "zod";
import { $Enums } from "@prisma/client";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ApiKeyUser } from "@/lib/api-auth";
import { isAboveClearance } from "@/lib/classification";
import { prismaInternal, withClearance } from "@/lib/db";
import { intakeAsset } from "@/lib/domain/asset-intake";
import {
  createResumableUploadSession,
  downloadFromDrive,
  finalizeDriveUpload,
  getDriveFileMeta,
  isDriveEnabled,
  trashDriveFile,
} from "@/lib/drive";
import { guessMimeKind } from "@/lib/mime";
import { generateAndUploadThumbnails } from "@/lib/thumbnails";
import { ASSET_DRAFT_FIELDS, createdAssetPayload, prepareAssetDraft } from "./asset-input";
import { logMcpToolCall } from "./audit";
import { fail, ok, toToolError } from "./result";
import type { ToolContext } from "./tools";

/**
 * ファイル本体 (画像・動画など) を Drive に上げてアセットにする MCP ツール (#84)。
 *
 * MCP サーバーは Vercel 上のリモート HTTP なので、エージェントの手元のファイルパスは読めず、
 * バイト列を引数で送ると 4.5MB の body 上限に当たる。そこで本体はエージェントが Drive に直接送る:
 *   1. akashic_begin_upload で Drive の resumable upload URL を受け取る
 *   2. エージェントが curl -X PUT --upload-file で URL に送り、返った JSON の id を得る
 *   3. akashic_complete_upload にその id を渡して inbox に登録する
 *
 * 保存先は GOOGLE_DRIVE_FOLDER_ID に固定する (REST の driveFolderId は受けない)。complete は
 * 渡された driveFileId がそのフォルダに最近できた、まだどのアセットも指していないファイルかを確かめる。
 * finalizeDriveUpload はファイルを「リンクを知っていれば誰でも閲覧可」にするので、検証しないと
 * 任意の driveFileId を渡して別のファイルを公開する口になる。
 */

/** Drive の resumable session は 1 週間有効。それより古いファイルは begin で発行した先ではない */
const UPLOAD_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

const SHA256 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "SHA-256 の 16 進 64 文字で指定してください")
  .transform((s) => s.toLowerCase());

/**
 * sha256 が一致する既存アセットを探す。RLS をバイパスして全件から引くので、
 * キーのクリアランスを超えるものは ID を返さない (存在だけ伝える)。
 */
async function findDuplicate(where: { sha256: string } | { storageKey: string }) {
  return prismaInternal.asset.findFirst({
    where,
    select: { id: true, title: true, classification: true },
  });
}

function duplicatePayload(
  dup: { id: string; title: string; classification: string },
  user: ApiKeyUser,
  baseUrl: string
) {
  if (isAboveClearance(dup.classification, user.clearance)) {
    return fail("同じファイルが既に登録されています (クリアランス外のため ID は返せません)。");
  }
  return ok({
    duplicate: true,
    existingId: dup.id,
    title: dup.title,
    url: `${baseUrl}/assets/${dup.id}`,
    hint: "同じファイルが既に登録されているので、新しくは作っていません。メタデータを足すなら akashic_update_asset を使ってください。",
  });
}

export function registerUploadTools(server: McpServer, { user, baseUrl }: ToolContext) {
  server.registerTool(
    "akashic_begin_upload",
    {
      title: "ファイルアップロードの開始",
      description:
        "画像・動画などのファイルを Drive に上げてアセットにする 3 手順の 1 つ目。" +
        "Drive の upload URL を返すので、手元で curl -X PUT --upload-file <path> <uploadUrl> を実行し、" +
        "返った JSON の id を akashic_complete_upload の driveFileId に渡す。" +
        "sha256 が既存アセットと一致したら URL は出さず existingId を返す (アップロード不要)。" +
        "sha256 は shasum -a 256 <path> で求める。",
      inputSchema: z.object({
        filename: z.string().min(1).describe("Drive 上のファイル名 (例: 20250430_wakemon.mp4)"),
        mimeType: z.string().min(1).describe("MIME タイプ (例: video/mp4, image/jpeg)"),
        sha256: SHA256.describe("ファイルの SHA-256 (16 進)。重複判定に使う"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        const dup = await findDuplicate({ sha256: args.sha256 });
        if (dup) return duplicatePayload(dup, user, baseUrl);

        if (!isDriveEnabled()) {
          return fail("Google Drive が未設定のため、ファイルをアップロードできません。");
        }
        const uploadUrl = await createResumableUploadSession(args.filename, args.mimeType);
        if (!uploadUrl) return fail("Drive の upload URL を発行できませんでした。");

        return ok({
          duplicate: false,
          uploadUrl,
          // URL にはクエリ文字が入るのでシングルクォートで包む
          command: `curl -sS -X PUT -H 'Content-Type: ${args.mimeType}' --upload-file <path> '${uploadUrl}'`,
          next:
            "command の <path> をファイルパスに置き換えて実行し、返った JSON の id を driveFileId、" +
            "同じ sha256 を添えて akashic_complete_upload を呼んでください。URL の有効期限は 1 週間です。",
        });
      } catch (err) {
        return toToolError(err, "アップロードの開始に失敗しました。");
      }
    }
  );

  server.registerTool(
    "akashic_complete_upload",
    {
      title: "ファイルアップロードの完了",
      description:
        "akashic_begin_upload の URL に送ったファイルを、アセットとして登録する。" +
        "引数は akashic_create_asset と同じで、status は必ず inbox。kind は省略すると MIME から決まる。" +
        "sha256 が既存と一致したら、送ったファイルは片付けて existingId を返す。",
      inputSchema: z.object({
        driveFileId: z.string().min(1).describe("Drive への PUT が返した JSON の id"),
        sha256: SHA256.describe("akashic_begin_upload に渡したのと同じ SHA-256"),
        kind: z.enum($Enums.AssetKind).optional().describe("アセット種別。省略時は MIME から推定"),
        ...ASSET_DRAFT_FIELDS,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        if (!isDriveEnabled()) {
          return fail("Google Drive が未設定のため、ファイルを登録できません。");
        }

        const meta = await getDriveFileMeta(args.driveFileId);
        if (!meta) {
          return fail("Drive にそのファイルがありません。upload URL への PUT が終わっているか確認してください。", {
            driveFileId: args.driveFileId,
          });
        }
        const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID ?? "";
        if (
          meta.trashed ||
          !folderId ||
          !meta.parents.includes(folderId) ||
          !meta.createdTime ||
          Date.now() - meta.createdTime.getTime() > UPLOAD_MAX_AGE_MS
        ) {
          return fail("そのファイルは akashic_begin_upload で発行した先のものではありません。", {
            driveFileId: args.driveFileId,
          });
        }
        // 既にどれかのアセットの実体になっているファイルは登録し直さない。
        // 重複扱いで片付けると、そのアセットの原本を消してしまう
        const owner = await findDuplicate({ storageKey: args.driveFileId });
        if (owner) return duplicatePayload(owner, user, baseUrl);

        // Drive が計算した値があればそれを正とする (申告値だけを信じない)
        if (meta.sha256 && meta.sha256.toLowerCase() !== args.sha256) {
          return fail("sha256 が Drive 上のファイルと一致しません。送ったファイルと sha256 を確認してください。", {
            declared: args.sha256,
            drive: meta.sha256.toLowerCase(),
          });
        }
        const sha256 = args.sha256;

        const dup = await findDuplicate({ sha256 });
        if (dup) {
          // 送ってもらった実体は要らないのでゴミ箱へ (孤児を残さない。30 日は戻せる)
          await trashDriveFile(args.driveFileId).catch((e) =>
            console.warn("[mcp] 重複ファイルの片付けに失敗:", e)
          );
          return duplicatePayload(dup, user, baseUrl);
        }

        const prepared = await prepareAssetDraft(args, user);
        if ("error" in prepared) return prepared.error;
        const { data, resolution } = prepared.draft;

        const mimeType = meta.mimeType || "application/octet-stream";
        const kind = args.kind ?? guessMimeKind(mimeType);
        const finalized = await finalizeDriveUpload(args.driveFileId);

        const asset = await intakeAsset(
          {
            ...data,
            kind,
            storageProvider: "gdrive",
            storageUrl: finalized.webViewLink,
            storageKey: finalized.fileId,
            sha256,
            originalFilename: meta.name,
            mimeType,
            fileSize: meta.size,
            thumbnailUrl: kind === "image" ? finalized.webViewLink : null,
          },
          user.id,
          user.clearance
        );

        // 画像は R2 のサムネイルを作る (REST の /upload/complete と同じ)。失敗してもアセットは残す
        if (kind === "image") {
          try {
            const buffer = await downloadFromDrive(finalized.fileId);
            const r2Url = buffer ? await generateAndUploadThumbnails(asset.id, buffer) : null;
            if (r2Url) {
              await withClearance(user.clearance, (tx) =>
                tx.asset.update({ where: { id: asset.id }, data: { thumbnailUrl: r2Url } })
              );
            }
          } catch (err) {
            console.error("[mcp] R2 サムネイル生成に失敗:", err);
          }
        }

        await logMcpToolCall({
          user,
          tool: "complete_upload",
          targetType: "Asset",
          targetId: asset.id,
          args: { kind, title: args.title, driveFileId: args.driveFileId, sha256, sourceType: data.sourceType },
        });

        return ok({ duplicate: false, ...createdAssetPayload(asset, resolution, baseUrl) });
      } catch (err) {
        return toToolError(err, "アップロードの登録に失敗しました。");
      }
    }
  );
}
