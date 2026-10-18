import * as z from "zod";
import { $Enums } from "@prisma/client";
import { parseDateOnly } from "@/lib/domain/coverage";
import type { AssetIntakeData } from "@/lib/domain/asset-intake";

export const DISCORD_MEMO_CHANNELS = {
  nina_memo: "新奈メモ",
  fieldwork: "フィールドワーク",
} as const;

const SNOWFLAKE = /^\d{17,20}$/;

export const DiscordMemoInputSchema = z
  .object({
    channel: z.enum(["nina_memo", "fieldwork"]),
    guildId: z.string().regex(SNOWFLAKE, "Discord のサーバー ID が不正です"),
    channelId: z.string().regex(SNOWFLAKE, "Discord のチャンネル ID が不正です"),
    messageId: z.string().regex(SNOWFLAKE, "Discord のメッセージ ID が不正です"),
    messageUrl: z.string().url("Discord メッセージ URL が不正です"),
    authorId: z.string().regex(SNOWFLAKE, "Discord の投稿者 ID が不正です"),
    authorName: z.string().trim().min(1, "投稿者名を指定してください"),
    postedAt: z.string().datetime({ offset: true }),
    title: z.string().trim().min(1, "タイトルを指定してください").max(200),
    body: z.string().trim().min(1, "本文を指定してください").max(100_000),
    classification: z.enum($Enums.ClearanceLevel).optional(),
  })
  .superRefine((value, ctx) => {
    const date = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value.postedAt);
    if (date) {
      const [year, month, day] = date.slice(1).map(Number);
      const check = new Date(Date.UTC(year, month - 1, day));
      if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
        ctx.addIssue({ code: "custom", path: ["postedAt"], message: "存在しない日時です" });
      }
    }
    let url: URL;
    try {
      url = new URL(value.messageUrl);
    } catch {
      return;
    }
    const expectedPath = `/channels/${value.guildId}/${value.channelId}/${value.messageId}`;
    if (url.protocol !== "https:" || url.hostname !== "discord.com" || url.pathname !== expectedPath) {
      ctx.addIssue({
        code: "custom",
        path: ["messageUrl"],
        message: "Discord メッセージ URL が guildId / channelId / messageId と一致しません",
      });
    }
  });

export type DiscordMemoInput = z.infer<typeof DiscordMemoInputSchema>;

export function parseDiscordMemoInput(input: unknown): DiscordMemoInput {
  return DiscordMemoInputSchema.parse(input);
}

export function isAllowedDiscordMemoChannel(
  input: Pick<DiscordMemoInput, "channel" | "guildId" | "channelId">,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): boolean {
  const expectedChannel = input.channel === "nina_memo" ? env.NINA_MEMO_CHANNEL_ID : env.FIELDWORK_CHANNEL_ID;
  return Boolean(expectedChannel && env.DISCORD_MEMO_GUILD_ID && input.guildId === env.DISCORD_MEMO_GUILD_ID && input.channelId === expectedChannel);
}

/** Discord の投稿時刻を、アセットの日付列用の JST 暦日に正規化する。 */
function toJstDate(iso: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  const dateOnly = `${part("year")}-${part("month")}-${part("day")}`;
  const parsed = parseDateOnly(dateOnly);
  if (!parsed) throw new Error("Discord 投稿日時を JST 日付へ変換できません");
  return parsed;
}

/** 承諾済みのDiscordメモを、既存の inbox アセット作成経路へ渡す形に組み立てる。 */
export function toDiscordMemoAsset(input: DiscordMemoInput): AssetIntakeData {
  const channelName = DISCORD_MEMO_CHANNELS[input.channel];
  const body = input.body.trim();

  return {
    kind: "text",
    classification: input.classification ?? "internal",
    title: input.title.trim(),
    status: "inbox",
    sourceType: "discord",
    canonicalDate: toJstDate(input.postedAt),
    messageBodyPreview: body.slice(0, 1_000),
    discordGuildId: input.guildId,
    discordChannelId: input.channelId,
    discordMessageId: input.messageId,
    discordMessageUrl: input.messageUrl,
    discordAuthorId: input.authorId,
    discordAuthorName: input.authorName.trim(),
    discordPostedAt: new Date(input.postedAt),
    texts: [{ textType: "body", content: body }],
    sourceRecords: [
      {
        sourceKind: "discord_message",
        title: `${channelName}: ${input.title.trim()}`,
        url: input.messageUrl,
        publishedAt: new Date(input.postedAt),
        metadata: { channel: input.channel },
      },
    ],
  };
}
