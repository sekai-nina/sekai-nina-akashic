-- ミーグリの予告コーデ (#203)
--
-- 本人が事前に公言した「次回以降のミーグリでのコーデ」を MeetGreet に持たせる。
-- これまでは sekai-nina-site の src/data/meetgreet-upcoming.json を手で書き換えていた。
-- 公開サイトはビルド時に GET /api/v1/meetgreets/upcoming を読む。
--
-- 既存テーブルへの列追加なので GRANT は不要。
ALTER TABLE "MeetGreet" ADD COLUMN "previewOutfit" TEXT NOT NULL DEFAULT '',
ADD COLUMN "previewSourceAssetIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
