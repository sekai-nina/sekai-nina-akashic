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
 * 保存先は GOOGLE_DRIVE_FOLDER_ID に固定する (REST の driveFolderId は受けない)。begin はファイルに
 * appProperties で「発行したキー」と「申告された sha256」を刻み、complete はそれが呼び出し元のキー・
 * 引数の sha256 と一致し、Drive が計算した SHA-256 とも一致するファイルしか受けない。
 * finalizeDriveUpload はファイルを「リンクを知っていれば誰でも閲覧可」にするので、検証しないと
 * 任意の driveFileId (REST や iPad ワーカーが上げ途中のファイルを含む) を公開する口になる。
 */

/**
 * resumable session は 1 週間有効。createdTime は PUT が終わった時刻なので、これより古いファイルは
 * まず無い。appProperties の照合が本命で、こちらは保険
 */
const UPLOAD_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

/** begin がファイルに刻む appProperties のキー */
const UPLOADER_PROP = "akashicMcpUploader";
const SHA256_PROP = "akashicMcpSha256";

/** サムネイルを作るために本体を落とす上限。これを超える画像はサムネイル無しで登録する */
const THUMBNAIL_MAX_BYTES = 50 * 1024 * 1024;

// command に埋め込むので、シェルのメタ文字を通さない形に絞る
const MIME_TYPE = z
  .string()
  .regex(/^[\w.+-]+\/[\w.+-]+$/, "MIME タイプの形式 (例: video/mp4) で指定してください");

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
    select: { id: true, title: true, classification: true, storageKey: true },
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
        "Drive の upload URL と curl コマンドを返すので、手元で <path> をファイルパスに置き換えて実行し、" +
        "返った JSON の id を akashic_complete_upload の driveFileId に渡す。" +
        "sha256 が既存アセットと一致したら URL は出さず existingId を返す (アップロード不要)。" +
        "sha256 は shasum -a 256 <path> で求める。",
      inputSchema: z.object({
        filename: z.string().min(1).describe("Drive 上のファイル名 (例: 20250430_wakemon.mp4)"),
        mimeType: MIME_TYPE.describe("MIME タイプ (例: video/mp4, image/jpeg)"),
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
        const uploadUrl = await createResumableUploadSession(args.filename, args.mimeType, undefined, {
          [UPLOADER_PROP]: user.apiKeyId,
          [SHA256_PROP]: args.sha256,
        });
        if (!uploadUrl) return fail("Drive の upload URL を発行できませんでした。");

        return ok({
          duplicate: false,
          uploadUrl,
          // URL にはクエリ文字が、パスには空白が入りうるのでシングルクォートで包む。
          // --fail-with-body がないと 4xx/5xx でも終了コード 0 になり、エラー本文から id を探しにいく
          command: `curl -sS --fail-with-body -X PUT -H 'Content-Type: ${args.mimeType}' --upload-file '<path>' '${uploadUrl}'`,
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
          meta.appProperties[UPLOADER_PROP] !== user.apiKeyId ||
          meta.appProperties[SHA256_PROP] !== args.sha256 ||
          !meta.createdTime ||
          Date.now() - meta.createdTime.getTime() > UPLOAD_MAX_AGE_MS
        ) {
          return fail("そのファイルは、このキーがこの sha256 で akashic_begin_upload した先のものではありません。", {
            driveFileId: args.driveFileId,
          });
        }
        // 既にどれかのアセットの実体になっているファイルは登録し直さない。
        // 重複扱いで片付けると、そのアセットの原本を消してしまう
        const owner = await findDuplicate({ storageKey: args.driveFileId });
        if (owner) return duplicatePayload(owner, user, baseUrl);

        // 申告値だけを信じない。Drive が計算した値と突き合わせる (重複判定と Asset.sha256 に使うため)
        if (!meta.sha256) {
          return fail("Drive がまだファイルの SHA-256 を出していません。少し待ってから再実行してください。");
        }
        if (meta.sha256.toLowerCase() !== args.sha256) {
          return fail("送ったファイルの中身が sha256 と一致しません。ファイルと sha256 を確認して begin からやり直してください。");
        }
        const sha256 = args.sha256;

        const dup = await findDuplicate({ sha256 });
        if (dup) {
          // 送ってもらった実体は要らないのでゴミ箱へ (孤児を残さない。30 日は戻せる)。
          // **ただし、どれかの Asset がその ID を実体として指しているなら触らない。** 同じ driveFileId の
          // complete が並行して走ると (タイムアウト後のリトライ)、上の storageKey 確認をすり抜けた後に
          // 相手が作った Asset が重複として見つかり、その原本を消してしまうため
          const referenced =
            dup.storageKey === args.driveFileId ||
            (await prismaInternal.asset.count({ where: { storageKey: args.driveFileId } })) > 0;
          if (!referenced) {
            await trashDriveFile(args.driveFileId).catch((e) =>
              console.warn("[mcp] 重複ファイルの片付けに失敗:", e)
            );
          }
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

        // 監査ログはサムネイルより先に書く (サムネイルで落ちても作成の記録は残す)
        await logMcpToolCall({
          user,
          tool: "complete_upload",
          targetType: "Asset",
          targetId: asset.id,
          args: { kind, title: args.title, driveFileId: args.driveFileId, sha256, sourceType: data.sourceType },
        });

        // 画像は R2 のサムネイルを作る (REST の /upload/complete と同じ)。失敗してもアセットは残す。
        // kind は上書きできるので MIME とサイズで判定する (大きな動画を image 扱いで丸ごと読まない)
        if (
          kind === "image" &&
          mimeType.startsWith("image/") &&
          meta.size != null &&
          meta.size <= THUMBNAIL_MAX_BYTES
        ) {
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

        return ok({ duplicate: false, ...createdAssetPayload(asset, resolution, baseUrl) });
      } catch (err) {
        return toToolError(err, "アップロードの登録に失敗しました。");
      }
    }
  );
}
