-- 曲マスタ (#167): Song に名寄せキー・アーティスト・参加フラグを足し、収録作品 Release /
-- ReleaseTrack を足す
--
-- #149 で入れた Song は公演フォームで打った曲名の find-or-create だけで、表記揺れを寄せる
-- 鍵も収録シングルの情報も無かった。公式ディスコグラフィ (Sony Music の JSON API) を
-- `pnpm cli:import-songs` で流し込み、曲ごとの収録盤・披露履歴が引けるようにする。
--
--   - Song.normalizedTitle は名寄せのキー (NFKC → 小文字 → 空白・記号を落とす)。既存 53 行は
--     ここでは lower + 空白除去の仮の値を入れて NOT NULL / UNIQUE を張り、正しい値は
--     cli:import-songs が TS 側の normalizeSongTitle で計算し直す (SQL と TS で規則を二重に
--     持たない)
--   - Release は TYPE-A〜D / 通常盤を 1 作品にまとめ、盤の内訳は editions (Json) に持つ。
--     sonyCode (代表品番) が取り込みの冪等キー
--   - ReleaseTrack は全盤の和集合。どの盤に入っているかは editions (品番の配列)
--   - 3 テーブルとも非保護 (公開情報)。Supabase 既定の anon / authenticated 権限は剥がす
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "Release", "ReleaseTrack" TO app_runtime;
--
-- 本番は SQL (+ GRANT) を先に当ててからデプロイする (新コードは Song.normalizedTitle を
-- 読むので、列が無いと /lives の公演保存が落ちる。旧コードは新しい列を参照しない)。

-- CreateEnum
CREATE TYPE "SongParticipation" AS ENUM ('unknown', 'member', 'none');

-- CreateEnum
CREATE TYPE "ReleaseKind" AS ENUM ('single', 'album');

-- AlterTable (normalizedTitle は既存行を埋めてから NOT NULL にする)
ALTER TABLE "Song" ADD COLUMN     "artist" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "normalizedTitle" TEXT,
ADD COLUMN     "note" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "participation" "SongParticipation" NOT NULL DEFAULT 'unknown';

UPDATE "Song" SET "normalizedTitle" = lower(regexp_replace("title", '\s+', '', 'g'));

ALTER TABLE "Song" ALTER COLUMN "normalizedTitle" SET NOT NULL;

-- CreateTable
CREATE TABLE "Release" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "ReleaseKind" NOT NULL,
    "releaseDate" TEXT NOT NULL,
    "artist" TEXT NOT NULL DEFAULT '',
    "sonyCode" TEXT NOT NULL,
    "editions" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReleaseTrack" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "songId" TEXT NOT NULL,
    "discNo" INTEGER NOT NULL DEFAULT 1,
    "trackNo" INTEGER NOT NULL,
    "editions" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "ReleaseTrack_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Release_sonyCode_key" ON "Release"("sonyCode");

-- CreateIndex
CREATE INDEX "Release_releaseDate_idx" ON "Release"("releaseDate");

-- CreateIndex
CREATE INDEX "ReleaseTrack_songId_idx" ON "ReleaseTrack"("songId");

-- CreateIndex
CREATE UNIQUE INDEX "ReleaseTrack_releaseId_songId_key" ON "ReleaseTrack"("releaseId", "songId");

-- CreateIndex
CREATE UNIQUE INDEX "Song_normalizedTitle_key" ON "Song"("normalizedTitle");

-- AddForeignKey
ALTER TABLE "ReleaseTrack" ADD CONSTRAINT "ReleaseTrack_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseTrack" ADD CONSTRAINT "ReleaseTrack_songId_fkey" FOREIGN KEY ("songId") REFERENCES "Song"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 非保護テーブル。Supabase の既定で付く anon / authenticated の DML を剥がす
-- (20260919020000_revoke_anon_on_unprotected と同じ理由)
REVOKE ALL ON TABLE "Release", "ReleaseTrack" FROM anon, authenticated;
