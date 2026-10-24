-- ミーグリの盤 (通常盤 / 初回限定盤) とペアレーンの相手 (#242 の続き)。nullable / 既定値つきの列追加だけ
CREATE TYPE "MeetGreetEdition" AS ENUM ('regular', 'limited');

ALTER TABLE "MeetGreet" ADD COLUMN "edition" "MeetGreetEdition",
ADD COLUMN "pairMember" TEXT NOT NULL DEFAULT '';
