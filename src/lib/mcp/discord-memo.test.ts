import { describe, expect, it } from "vitest";
import { isAllowedDiscordMemoChannel, parseDiscordMemoInput, toDiscordMemoAsset } from "./discord-memo";

const base = {
  channel: "nina_memo" as const,
  guildId: "123456789012345678",
  channelId: "223456789012345678",
  messageId: "323456789012345678",
  messageUrl: "https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678",
  authorId: "423456789012345678",
  authorName: "投稿者",
  postedAt: "2026-10-17T15:30:00.000Z",
  title: "秋のロケ地メモ",
  body: "本文です",
};

describe("DiscordメモのMCP入力", () => {
  it("投稿情報を inbox のDiscordアセットへ変換する", () => {
    const asset = toDiscordMemoAsset(parseDiscordMemoInput(base));

    expect(asset).toMatchObject({
      kind: "text",
      status: "inbox",
      sourceType: "discord",
      classification: "internal",
      title: "秋のロケ地メモ",
      discordMessageId: base.messageId,
      discordPostedAt: new Date(base.postedAt),
    });
    expect(asset.canonicalDate?.toISOString()).toBe("2026-10-18T00:00:00.000Z");
    expect(asset.texts).toEqual([{ textType: "body", content: "本文です" }]);
    expect(asset.sourceRecords?.[0]).toMatchObject({
      sourceKind: "discord_message",
      title: "新奈メモ: 秋のロケ地メモ",
      url: base.messageUrl,
    });
  });

  it("メッセージURLとIDの不一致を拒否する", () => {
    expect(() =>
      parseDiscordMemoInput({ ...base, messageUrl: "https://discord.com/channels/123456789012345678/223456789012345678/523456789012345678" })
    ).toThrow(/一致/);
  });

  it("存在しない投稿日を拒否する", () => {
    expect(() => parseDiscordMemoInput({ ...base, postedAt: "2026-02-30T15:30:00.000Z" })).toThrow(/存在しない/);
  });

  it("設定されたチャンネルだけを許可する", () => {
    const input = parseDiscordMemoInput(base);
    const env = { DISCORD_MEMO_GUILD_ID: base.guildId, NINA_MEMO_CHANNEL_ID: base.channelId, FIELDWORK_CHANNEL_ID: "999999999999999999" };
    expect(isAllowedDiscordMemoChannel(input, env)).toBe(true);
    expect(isAllowedDiscordMemoChannel({ ...input, channelId: "999999999999999999" }, env)).toBe(false);
  });

  it("添付を示す任意の入力を保存しない", () => {
    const parsed = parseDiscordMemoInput({ ...base, attachments: ["https://example.com/image.png"] });
    expect(parsed).not.toHaveProperty("attachments");
  });
});
