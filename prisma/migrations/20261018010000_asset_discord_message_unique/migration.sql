-- Discord メモ取り込みで同じ投稿を複数の inbox アセットにしないため、
-- Discord の guild / channel / message の組を一意にする。
-- nullable な組なので、Discord由来でない既存アセットには影響しない。
ALTER TABLE "Asset"
  ADD CONSTRAINT "Asset_discordGuildId_discordChannelId_discordMessageId_key"
  UNIQUE ("discordGuildId", "discordChannelId", "discordMessageId");
