/**
 * Google Driveのバックアップからデータを復元する。
 *
 * 復元順序:
 *   1. ユーザー
 *   2. エンティティ
 *   3. アセット（テキスト、出典、アノテーション含む）
 *   4. コレクション（アイテム含む）
 *
 * 既存IDと衝突するレコードはスキップする（冪等）。
 *
 * Usage:
 *   pnpm cli:restore
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import {
  getOrCreateDriveFolder,
  listDriveFiles,
  downloadFromDrive,
} from "../lib/drive/index.js";

const prisma = new PrismaClient();

async function downloadJson<T>(fileId: string): Promise<T> {
  const buffer = await downloadFromDrive(fileId);
  if (!buffer) throw new Error(`Failed to download file ${fileId}`);
  return JSON.parse(buffer.toString("utf-8"));
}

async function main() {
  const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!rootFolderId) {
    console.error("GOOGLE_DRIVE_FOLDER_ID is not set");
    process.exit(1);
  }

  console.log("Finding backup folder on Drive...");
  const backupFolderId = await getOrCreateDriveFolder(rootFolderId, "akashic-backup");
  if (!backupFolderId) {
    console.error("Backup folder not found");
    process.exit(1);
  }

  const files = await listDriveFiles(backupFolderId);
  const fileMap = new Map(files.map((f) => [f.name, f.id]));

  console.log(`Found ${files.length} files in backup.`);

  // --- 1. ユーザーの復元 ---
  const usersFileId = fileMap.get("_users.json");
  if (usersFileId) {
    const users = await downloadJson<Array<Record<string, unknown>>>(usersFileId);
    let restored = 0;
    for (const user of users) {
      const exists = await prisma.user.findUnique({ where: { id: user.id as string } });
      if (exists) continue;
      await prisma.user.create({
        data: {
          id: user.id as string,
          email: user.email as string,
          name: user.name as string,
          passwordHash: user.passwordHash as string,
          role: user.role as "admin" | "member" | "viewer",
          createdAt: new Date(user.createdAt as string),
          updatedAt: new Date(user.updatedAt as string),
        },
      });
      restored++;
    }
    console.log(`Users: ${restored} restored, ${users.length - restored} skipped`);
  }

  // --- 2. エンティティの復元 ---
  const entitiesFileId = fileMap.get("_entities.json");
  if (entitiesFileId) {
    const entities = await downloadJson<Array<Record<string, unknown>>>(entitiesFileId);
    let restored = 0;
    for (const entity of entities) {
      const exists = await prisma.entity.findUnique({ where: { id: entity.id as string } });
      if (exists) continue;
      await prisma.entity.create({
        data: {
          id: entity.id as string,
          type: entity.type as never,
          canonicalName: entity.canonicalName as string,
          normalizedName: (entity.normalizedName as string) || "",
          aliases: entity.aliases as object,
          description: (entity.description as string) || "",
          createdAt: new Date(entity.createdAt as string),
          updatedAt: new Date(entity.updatedAt as string),
        },
      });
      restored++;
    }
    console.log(`Entities: ${restored} restored, ${entities.length - restored} skipped`);
  }

  // --- 3. アセットの復元 ---
  const assetFiles = files.filter(
    (f) => !f.name.startsWith("_") && f.name.endsWith(".json")
  );
  console.log(`Restoring ${assetFiles.length} assets...`);

  let assetRestored = 0;
  let assetSkipped = 0;

  for (const file of assetFiles) {
    const data = await downloadJson<Record<string, unknown>>(file.id);
    const assetId = data.id as string;

    const exists = await prisma.asset.findUnique({ where: { id: assetId } });
    if (exists) {
      assetSkipped++;
      continue;
    }

    const texts = (data.texts as Array<Record<string, unknown>>) || [];
    const entities = (data.entities as Array<Record<string, unknown>>) || [];
    const sourceRecords = (data.sourceRecords as Array<Record<string, unknown>>) || [];
    const annotations = (data.annotations as Array<Record<string, unknown>>) || [];

    await prisma.asset.create({
      data: {
        id: assetId,
        kind: data.kind as never,
        title: (data.title as string) || "",
        description: (data.description as string) || "",
        status: data.status as never,
        trustLevel: data.trustLevel as never,
        canonicalDate: data.canonicalDate ? new Date(data.canonicalDate as string) : null,
        originalFilename: (data.originalFilename as string) || null,
        mimeType: (data.mimeType as string) || null,
        fileSize: (data.fileSize as number) || null,
        sha256: (data.sha256 as string) || null,
        sourceType: data.sourceType as never,
        storageProvider: data.storageProvider as never,
        storageKey: (data.storageKey as string) || null,
        storageUrl: (data.storageUrl as string) || null,
        thumbnailUrl: (data.thumbnailUrl as string) || null,
        messageBodyPreview: (data.messageBodyPreview as string) || null,
        discordGuildId: (data.discordGuildId as string) || null,
        discordChannelId: (data.discordChannelId as string) || null,
        discordMessageId: (data.discordMessageId as string) || null,
        discordMessageUrl: (data.discordMessageUrl as string) || null,
        discordAuthorId: (data.discordAuthorId as string) || null,
        discordAuthorName: (data.discordAuthorName as string) || null,
        discordPostedAt: data.discordPostedAt ? new Date(data.discordPostedAt as string) : null,
        createdById: (data.createdById as string) || null,
        updatedById: (data.updatedById as string) || null,
        createdAt: new Date(data.createdAt as string),
        updatedAt: new Date(data.updatedAt as string),
        texts: {
          create: texts.map((t) => ({
            id: t.id as string,
            textType: t.textType as never,
            content: t.content as string,
            normalizedContent: (t.normalizedContent as string) || "",
            language: (t.language as string) || null,
            createdById: (t.createdById as string) || null,
            createdAt: new Date(t.createdAt as string),
            updatedAt: new Date(t.updatedAt as string),
          })),
        },
        sourceRecords: {
          create: sourceRecords.map((s) => ({
            id: s.id as string,
            sourceKind: s.sourceKind as never,
            title: (s.title as string) || "",
            url: (s.url as string) || null,
            publisher: (s.publisher as string) || null,
            publishedAt: s.publishedAt ? new Date(s.publishedAt as string) : null,
            metadata: (s.metadata as object) || {},
            createdAt: new Date(s.createdAt as string),
            updatedAt: new Date(s.updatedAt as string),
          })),
        },
        annotations: {
          create: annotations.map((a) => ({
            id: a.id as string,
            kind: a.kind as never,
            body: (a.body as string) || "",
            startMs: (a.startMs as number) || null,
            endMs: (a.endMs as number) || null,
            textStart: (a.textStart as number) || null,
            textEnd: (a.textEnd as number) || null,
            bbox: (a.bbox as object) || null,
            createdById: a.createdById as string,
            createdAt: new Date(a.createdAt as string),
            updatedAt: new Date(a.updatedAt as string),
          })),
        },
      },
    });

    // AssetEntity は entityId が存在するもののみ復元
    for (const ae of entities) {
      const entityId = (ae as { entityId?: string }).entityId;
      if (!entityId) continue;
      const entityExists = await prisma.entity.findUnique({ where: { id: entityId } });
      if (!entityExists) continue;
      await prisma.assetEntity.create({
        data: {
          id: ae.id as string,
          assetId,
          entityId,
          roleLabel: (ae.roleLabel as string) || null,
          createdAt: new Date(ae.createdAt as string),
        },
      }).catch(() => {}); // 重複時は無視
    }

    assetRestored++;
    console.log(`  [${assetRestored + assetSkipped}/${assetFiles.length}] ${data.title || assetId}`);
  }

  // --- 4. コレクションの復元 ---
  const collectionsFileId = fileMap.get("_collections.json");
  if (collectionsFileId) {
    const collections = await downloadJson<Array<Record<string, unknown>>>(collectionsFileId);
    let restored = 0;
    for (const col of collections) {
      const exists = await prisma.collection.findUnique({ where: { id: col.id as string } });
      if (exists) continue;
      const items = (col.items as Array<Record<string, unknown>>) || [];
      await prisma.collection.create({
        data: {
          id: col.id as string,
          ownerId: col.ownerId as string,
          name: col.name as string,
          description: (col.description as string) || "",
          createdAt: new Date(col.createdAt as string),
          updatedAt: new Date(col.updatedAt as string),
          items: {
            create: items
              .filter((item) => {
                // アセットが復元済みか確認は省略（存在しなければPrismaがエラー）
                return item.assetId;
              })
              .map((item) => ({
                id: item.id as string,
                assetId: item.assetId as string,
                note: (item.note as string) || "",
                sortOrder: (item.sortOrder as number) || 0,
                createdAt: new Date(item.createdAt as string),
              })),
          },
        },
      }).catch((err) => {
        console.error(`  Collection restore failed: ${col.name}`, err.message);
      });
      restored++;
    }
    console.log(`Collections: ${restored} restored, ${collections.length - restored} skipped`);
  }

  console.log(`\nDone: ${assetRestored} assets restored, ${assetSkipped} skipped.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
