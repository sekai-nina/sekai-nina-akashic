/**
 * 全アセットをJSON形式でGoogle Driveにバックアップする。
 *
 * Drive上の構造:
 *   <GOOGLE_DRIVE_FOLDER_ID>/
 *     akashic-backup/
 *       <assetId>.json    ← アセットごとのフルデータ
 *       _entities.json    ← 全エンティティ
 *       _collections.json ← 全コレクション
 *       _users.json       ← 全ユーザー（パスワードハッシュ含む）
 *
 * Usage:
 *   pnpm cli:backup
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import {
  getOrCreateDriveFolder,
  uploadToFolder,
  listDriveFiles,
} from "../lib/drive/index.js";

const prisma = new PrismaClient();

async function main() {
  const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!rootFolderId) {
    console.error("GOOGLE_DRIVE_FOLDER_ID is not set");
    process.exit(1);
  }

  console.log("Creating backup folder on Drive...");
  const backupFolderId = await getOrCreateDriveFolder(rootFolderId, "akashic-backup");
  if (!backupFolderId) {
    console.error("Failed to create/find backup folder");
    process.exit(1);
  }

  // 既存のバックアップファイル一覧（上書き判定用）
  const existingFiles = await listDriveFiles(backupFolderId);
  const existingByName = new Map(existingFiles.map((f) => [f.name, f.id]));

  // --- アセットのバックアップ ---
  const assets = await prisma.asset.findMany({
    include: {
      texts: true,
      entities: { include: { entity: true } },
      sourceRecords: true,
      annotations: true,
      collectionItems: true,
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Backing up ${assets.length} assets...`);

  let uploaded = 0;
  let skipped = 0;

  for (const asset of assets) {
    const filename = `${asset.id}.json`;

    // 既存ファイルがあればスキップ（--force オプションで上書きも可能にしたければ拡張）
    if (existingByName.has(filename)) {
      skipped++;
      continue;
    }

    const json = JSON.stringify(asset, null, 2);
    const buffer = Buffer.from(json, "utf-8");

    const result = await uploadToFolder(
      backupFolderId,
      buffer,
      filename,
      "application/json"
    );

    if (result) {
      uploaded++;
      console.log(`  [${uploaded + skipped}/${assets.length}] ${asset.title || asset.id}`);
    } else {
      console.error(`  FAIL: ${asset.title || asset.id}`);
    }
  }

  // --- エンティティのバックアップ ---
  const entities = await prisma.entity.findMany({ orderBy: { createdAt: "asc" } });
  await uploadToFolder(
    backupFolderId,
    Buffer.from(JSON.stringify(entities, null, 2), "utf-8"),
    "_entities.json",
    "application/json"
  );
  console.log(`Backed up ${entities.length} entities`);

  // --- コレクションのバックアップ ---
  const collections = await prisma.collection.findMany({
    include: { items: true },
    orderBy: { createdAt: "asc" },
  });
  await uploadToFolder(
    backupFolderId,
    Buffer.from(JSON.stringify(collections, null, 2), "utf-8"),
    "_collections.json",
    "application/json"
  );
  console.log(`Backed up ${collections.length} collections`);

  // --- ユーザーのバックアップ ---
  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });
  await uploadToFolder(
    backupFolderId,
    Buffer.from(JSON.stringify(users, null, 2), "utf-8"),
    "_users.json",
    "application/json"
  );
  console.log(`Backed up ${users.length} users`);

  console.log(`\nDone: ${uploaded} uploaded, ${skipped} skipped (already backed up).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
