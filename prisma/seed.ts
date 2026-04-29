import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // Admin user (password is managed by Supabase Auth)
  const admin = await prisma.user.upsert({
    where: { email: "admin@akashic.local" },
    update: {},
    create: {
      email: "admin@akashic.local",
      name: "管理者",
      passwordHash: "",
      role: "admin",
    },
  });
  console.log("Created admin user:", admin.email);

  // Entities
  const entities = await Promise.all([
    prisma.entity.upsert({
      where: { type_canonicalName: { type: "person", canonicalName: "坂井新奈" } },
      update: {},
      create: {
        type: "person",
        canonicalName: "坂井新奈",
        normalizedName: "坂井新奈",
        aliases: ["さかいにな", "Nina Sakai"],
        description: "",
      },
    }),
    prisma.entity.upsert({
      where: { type_canonicalName: { type: "tag", canonicalName: "ブログ" } },
      update: {},
      create: {
        type: "tag",
        canonicalName: "ブログ",
        normalizedName: "ブログ",
        aliases: ["blog"],
      },
    }),
    prisma.entity.upsert({
      where: { type_canonicalName: { type: "tag", canonicalName: "トーク" } },
      update: {},
      create: {
        type: "tag",
        canonicalName: "トーク",
        normalizedName: "トーク",
        aliases: ["talk", "配信"],
      },
    }),
    prisma.entity.upsert({
      where: { type_canonicalName: { type: "source", canonicalName: "Discord" } },
      update: {},
      create: {
        type: "source",
        canonicalName: "Discord",
        normalizedName: "discord",
        aliases: [],
      },
    }),
  ]);
  console.log("Created entities:", entities.length);

  // Sample assets
  const asset1 = await prisma.asset.upsert({
    where: { id: "seed-asset-1" },
    update: {},
    create: {
      id: "seed-asset-1",
      kind: "text",
      title: "サンプルテキスト資料",
      description: "これはサンプルのテキスト資料です。検索テスト用に作成されました。",
      status: "inbox",
      trustLevel: "medium",
      sourceType: "manual",
      storageProvider: "local_none",
      createdById: admin.id,
      updatedById: admin.id,
    },
  });

  await prisma.assetText.upsert({
    where: { id: "seed-text-1" },
    update: {},
    create: {
      id: "seed-text-1",
      assetId: asset1.id,
      textType: "body",
      content: "世界新奈のアーカイブシステム「Akashic」のサンプルデータです。このテキストは検索機能のテストに使用されます。",
      normalizedContent: "世界新奈のアーカイブシステム「akashic」のサンプルデータです。このテキストは検索機能のテストに使用されます。",
      createdById: admin.id,
    },
  });

  // Link entity to asset
  await prisma.assetEntity.upsert({
    where: { assetId_entityId: { assetId: asset1.id, entityId: entities[0].id } },
    update: {},
    create: {
      assetId: asset1.id,
      entityId: entities[0].id,
      roleLabel: "featured",
    },
  });

  const asset2 = await prisma.asset.upsert({
    where: { id: "seed-asset-2" },
    update: {},
    create: {
      id: "seed-asset-2",
      kind: "image",
      title: "サンプル画像",
      description: "サンプルの画像 Asset です",
      status: "organized",
      trustLevel: "high",
      sourceType: "manual",
      storageProvider: "external_url",
      storageUrl: "https://via.placeholder.com/400x300",
      thumbnailUrl: "https://via.placeholder.com/400x300",
      createdById: admin.id,
      updatedById: admin.id,
    },
  });

  await prisma.assetEntity.upsert({
    where: { assetId_entityId: { assetId: asset2.id, entityId: entities[1].id } },
    update: {},
    create: {
      assetId: asset2.id,
      entityId: entities[1].id,
      roleLabel: "topic",
    },
  });

  const asset3 = await prisma.asset.upsert({
    where: { id: "seed-asset-3" },
    update: {},
    create: {
      id: "seed-asset-3",
      kind: "document",
      title: "Discord由来のメモ",
      description: "",
      status: "inbox",
      trustLevel: "unverified",
      sourceType: "discord",
      storageProvider: "discord_url",
      messageBodyPreview: "今日のトーク配信のメモです。重要なポイントをまとめました。",
      discordAuthorName: "testuser",
      discordMessageUrl: "https://discord.com/channels/123/456/789",
      createdById: admin.id,
      updatedById: admin.id,
    },
  });

  await prisma.assetText.upsert({
    where: { id: "seed-text-3" },
    update: {},
    create: {
      id: "seed-text-3",
      assetId: asset3.id,
      textType: "message_body",
      content: "今日のトーク配信のメモです。重要なポイントをまとめました。坂井新奈さんが話していた内容について。",
      normalizedContent: "今日のトーク配信のメモです。重要なポイントをまとめました。坂井新奈さんが話していた内容について。",
      createdById: admin.id,
    },
  });

  await prisma.assetEntity.upsert({
    where: { assetId_entityId: { assetId: asset3.id, entityId: entities[2].id } },
    update: {},
    create: {
      assetId: asset3.id,
      entityId: entities[2].id,
      roleLabel: "topic",
    },
  });

  // Sample collection
  await prisma.collection.upsert({
    where: { id: "seed-collection-1" },
    update: {},
    create: {
      id: "seed-collection-1",
      name: "調査用まとめ",
      description: "調査に使う資料をまとめたコレクション",
      ownerId: admin.id,
    },
  });

  await prisma.collectionItem.upsert({
    where: { collectionId_assetId: { collectionId: "seed-collection-1", assetId: asset1.id } },
    update: {},
    create: {
      collectionId: "seed-collection-1",
      assetId: asset1.id,
      note: "メインの参考資料",
      sortOrder: 0,
    },
  });

  await prisma.collectionItem.upsert({
    where: { collectionId_assetId: { collectionId: "seed-collection-1", assetId: asset2.id } },
    update: {},
    create: {
      collectionId: "seed-collection-1",
      assetId: asset2.id,
      note: "",
      sortOrder: 1,
    },
  });

  console.log("Seed complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
