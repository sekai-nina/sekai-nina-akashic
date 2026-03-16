import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  type ChatInputCommandInteraction,
  type MessageContextMenuCommandInteraction,
  type Message,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { uploadToDrive, isDriveEnabled } from "../lib/drive/index.js";
import { createHash } from "crypto";

const prisma = new PrismaClient();

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN!;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID!;
const APP_URL = process.env.AUTH_URL || "http://localhost:3000";

if (!BOT_TOKEN || !CLIENT_ID) {
  console.error("DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID are required");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
  ],
});

// Register commands
async function registerCommands() {
  const rest = new REST().setToken(BOT_TOKEN);

  const slashCommand = new SlashCommandBuilder()
    .setName("akashic")
    .setDescription("メッセージをAkashicに登録")
    .addStringOption((opt) =>
      opt.setName("message_id").setDescription("登録するメッセージのID").setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("title").setDescription("タイトル（省略時はメッセージ本文から自動生成）")
    );

  const contextMenu = new ContextMenuCommandBuilder()
    .setName("Akashicに登録")
    .setType(ApplicationCommandType.Message);

  await rest.put(Routes.applicationCommands(CLIENT_ID), {
    body: [slashCommand.toJSON(), contextMenu.toJSON()],
  });
  console.log("Commands registered");
}

function normalizeText(text: string): string {
  return text.toLowerCase().normalize("NFKC").replace(/[\s\u3000]+/g, " ").trim();
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  return Buffer.from(await res.arrayBuffer());
}

function guessMimeKind(mimeType: string): "image" | "video" | "audio" | "document" | "other" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.includes("pdf") || mimeType.includes("document") || mimeType.includes("text/")) return "document";
  return "other";
}

async function registerMessage(
  message: Message,
  titleOverride?: string
): Promise<{ assets: string[]; editUrls: string[] }> {
  const assets: string[] = [];
  const editUrls: string[] = [];

  const discordMeta = {
    discordGuildId: message.guildId,
    discordChannelId: message.channelId,
    discordMessageId: message.id,
    discordMessageUrl: message.url,
    discordAuthorId: message.author.id,
    discordAuthorName: message.author.username,
    discordPostedAt: message.createdAt,
  };

  const messageBody = message.content || "";
  const title = titleOverride || messageBody.slice(0, 100) || "Discord投稿";

  if (message.attachments.size > 0) {
    for (const attachment of message.attachments.values()) {
      const mimeType = attachment.contentType || "application/octet-stream";
      const kind = guessMimeKind(mimeType);

      let storageProvider: "gdrive" | "discord_url" = "discord_url";
      let storageUrl = attachment.url;
      let storageKey: string | null = null;
      let sha256: string | null = null;

      // Try to upload to Drive
      if (isDriveEnabled()) {
        try {
          const buffer = await fetchBuffer(attachment.url);
          sha256 = createHash("sha256").update(buffer).digest("hex");

          const driveResult = await uploadToDrive(buffer, attachment.name, mimeType);
          if (driveResult) {
            storageProvider = "gdrive";
            storageUrl = driveResult.webViewLink;
            storageKey = driveResult.fileId;
          }
        } catch (err) {
          console.error("Drive upload failed, using Discord URL:", err);
        }
      }

      // Check for duplicate
      if (sha256) {
        const existing = await prisma.asset.findFirst({ where: { sha256 } });
        if (existing) {
          assets.push(existing.id);
          editUrls.push(`${APP_URL}/assets/${existing.id}`);
          continue;
        }
      }

      const asset = await prisma.asset.create({
        data: {
          kind,
          title: message.attachments.size === 1 ? title : `${title} - ${attachment.name}`,
          description: "",
          status: "inbox",
          sourceType: "discord",
          storageProvider,
          storageUrl,
          storageKey,
          sha256,
          originalFilename: attachment.name,
          mimeType,
          fileSize: attachment.size,
          thumbnailUrl: kind === "image" ? attachment.url : null,
          messageBodyPreview: messageBody.slice(0, 500) || null,
          ...discordMeta,
        },
      });

      // Save message body as AssetText
      if (messageBody) {
        await prisma.assetText.create({
          data: {
            assetId: asset.id,
            textType: "message_body",
            content: messageBody,
            normalizedContent: normalizeText(messageBody),
          },
        });
      }

      await prisma.auditLog.create({
        data: {
          action: "asset.create_from_discord",
          targetType: "Asset",
          targetId: asset.id,
          metadata: { discordMessageUrl: message.url },
        },
      });

      assets.push(asset.id);
      editUrls.push(`${APP_URL}/assets/${asset.id}`);
    }
  } else {
    // Text-only message
    const asset = await prisma.asset.create({
      data: {
        kind: "text",
        title,
        description: "",
        status: "inbox",
        sourceType: "discord",
        storageProvider: "local_none",
        messageBodyPreview: messageBody.slice(0, 500) || null,
        ...discordMeta,
      },
    });

    if (messageBody) {
      await prisma.assetText.create({
        data: {
          assetId: asset.id,
          textType: "message_body",
          content: messageBody,
          normalizedContent: normalizeText(messageBody),
        },
      });
    }

    await prisma.auditLog.create({
      data: {
        action: "asset.create_from_discord",
        targetType: "Asset",
        targetId: asset.id,
        metadata: { discordMessageUrl: message.url },
      },
    });

    assets.push(asset.id);
    editUrls.push(`${APP_URL}/assets/${asset.id}`);
  }

  return { assets, editUrls };
}

// Handle slash command
client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === "akashic") {
    const cmd = interaction as ChatInputCommandInteraction;
    await cmd.deferReply({ ephemeral: true });

    try {
      const messageId = cmd.options.getString("message_id", true);
      const channel = await cmd.client.channels.fetch(cmd.channelId);
      if (!channel || !channel.isTextBased()) {
        await cmd.editReply("テキストチャンネルでのみ使用できます");
        return;
      }

      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (!message) {
        await cmd.editReply("メッセージが見つかりません。IDを確認してください。");
        return;
      }

      const titleOverride = cmd.options.getString("title") || undefined;
      const { editUrls } = await registerMessage(message, titleOverride);

      await cmd.editReply(
        `Akashicに登録しました (${editUrls.length}件)\n` +
        editUrls.map((url) => `→ ${url}`).join("\n")
      );
    } catch (err) {
      console.error("Error registering:", err);
      await cmd.editReply("登録に失敗しました");
    }
  }

  if (interaction.isMessageContextMenuCommand() && interaction.commandName === "Akashicに登録") {
    const ctx = interaction as MessageContextMenuCommandInteraction;
    await ctx.deferReply({ ephemeral: true });

    try {
      const { editUrls } = await registerMessage(ctx.targetMessage as Message);

      await ctx.editReply(
        `Akashicに登録しました (${editUrls.length}件)\n` +
        editUrls.map((url) => `→ ${url}`).join("\n")
      );
    } catch (err) {
      console.error("Error registering:", err);
      await ctx.editReply("登録に失敗しました");
    }
  }
});

client.once("ready", () => {
  console.log(`Bot logged in as ${client.user?.tag}`);
});

async function main() {
  await registerCommands();
  await client.login(BOT_TOKEN);
}

main().catch(console.error);
