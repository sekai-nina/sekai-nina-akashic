-- レポ収集 (curepo 由来) — Twitter ミーグリレポ収集・選別
-- 追加のみ。既存の trgm/pgroonga 等のスキーマ未管理インデックスには触れない。

-- CreateEnum
CREATE TYPE "RepoTweetStatus" AS ENUM ('undecided', 'keep', 'reject');

-- CreateTable
CREATE TABLE "RepoCollection" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "groups" JSONB NOT NULL,
    "groupOp" TEXT NOT NULL DEFAULT 'or',
    "query" TEXT NOT NULL,
    "startDate" TEXT,
    "endDate" TEXT,
    "excludeRetweets" BOOLEAN NOT NULL DEFAULT true,
    "langJa" BOOLEAN NOT NULL DEFAULT true,
    "extra" TEXT NOT NULL DEFAULT '',
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',
    "sourceLegacyId" INTEGER,
    "lastFetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepoCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepoTweet" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "tweetId" TEXT NOT NULL,
    "authorUsername" TEXT NOT NULL DEFAULT '',
    "authorName" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL DEFAULT '',
    "tweetedAt" TIMESTAMP(3),
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "retweetCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "quoteCount" INTEGER NOT NULL DEFAULT 0,
    "url" TEXT NOT NULL,
    "status" "RepoTweetStatus" NOT NULL DEFAULT 'undecided',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepoTweet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepoTweetMedia" (
    "id" TEXT NOT NULL,
    "tweetId" TEXT NOT NULL,
    "mediaKey" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'photo',
    "remoteUrl" TEXT,
    "imageKey" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "altText" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "RepoTweetMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RepoCollection_sourceLegacyId_key" ON "RepoCollection"("sourceLegacyId");

-- CreateIndex
CREATE INDEX "RepoCollection_classification_idx" ON "RepoCollection"("classification");

-- CreateIndex
CREATE INDEX "RepoTweet_collectionId_status_idx" ON "RepoTweet"("collectionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RepoTweet_collectionId_tweetId_key" ON "RepoTweet"("collectionId", "tweetId");

-- CreateIndex
CREATE UNIQUE INDEX "RepoTweetMedia_tweetId_mediaKey_key" ON "RepoTweetMedia"("tweetId", "mediaKey");

-- AddForeignKey
ALTER TABLE "RepoTweet" ADD CONSTRAINT "RepoTweet_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "RepoCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepoTweetMedia" ADD CONSTRAINT "RepoTweetMedia_tweetId_fkey" FOREIGN KEY ("tweetId") REFERENCES "RepoTweet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS (clearance ベース、fail-closed)。clearance_rank() は 20260511000000_add_rls 定義。
-- app_runtime ロールに対し set_config('app.clearance', ...) を要求する。
-- ============================================================

-- RepoCollection: 自身の classification を clearance で判定（Asset/Testimonial と同形）
ALTER TABLE "RepoCollection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RepoCollection" FORCE  ROW LEVEL SECURITY;

CREATE POLICY repocollection_select ON "RepoCollection" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY repocollection_insert ON "RepoCollection" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY repocollection_update ON "RepoCollection" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY repocollection_delete ON "RepoCollection" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);

-- RepoTweet: 親 RepoCollection が可視なら可視（AssetText の親参照パターン）
ALTER TABLE "RepoTweet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RepoTweet" FORCE  ROW LEVEL SECURITY;

CREATE POLICY repotweet_select ON "RepoTweet" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "RepoCollection" c WHERE c.id = "RepoTweet"."collectionId"
    AND clearance_rank(c.classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY repotweet_insert ON "RepoTweet" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM "RepoCollection" c WHERE c.id = "RepoTweet"."collectionId"
    AND clearance_rank(c.classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY repotweet_update ON "RepoTweet" FOR UPDATE TO app_runtime
  USING (EXISTS (SELECT 1 FROM "RepoCollection" c WHERE c.id = "RepoTweet"."collectionId"
    AND clearance_rank(c.classification::text) <= clearance_rank(current_setting('app.clearance', true))))
  WITH CHECK (EXISTS (SELECT 1 FROM "RepoCollection" c WHERE c.id = "RepoTweet"."collectionId"
    AND clearance_rank(c.classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY repotweet_delete ON "RepoTweet" FOR DELETE TO app_runtime USING (
  EXISTS (SELECT 1 FROM "RepoCollection" c WHERE c.id = "RepoTweet"."collectionId"
    AND clearance_rank(c.classification::text) <= clearance_rank(current_setting('app.clearance', true))));

-- RepoTweetMedia: 親 RepoTweet→RepoCollection 経由で可視判定
ALTER TABLE "RepoTweetMedia" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RepoTweetMedia" FORCE  ROW LEVEL SECURITY;

CREATE POLICY repotweetmedia_select ON "RepoTweetMedia" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "RepoTweet" t JOIN "RepoCollection" c ON c.id = t."collectionId"
    WHERE t.id = "RepoTweetMedia"."tweetId"
    AND clearance_rank(c.classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY repotweetmedia_insert ON "RepoTweetMedia" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM "RepoTweet" t JOIN "RepoCollection" c ON c.id = t."collectionId"
    WHERE t.id = "RepoTweetMedia"."tweetId"
    AND clearance_rank(c.classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY repotweetmedia_update ON "RepoTweetMedia" FOR UPDATE TO app_runtime
  USING (EXISTS (SELECT 1 FROM "RepoTweet" t JOIN "RepoCollection" c ON c.id = t."collectionId"
    WHERE t.id = "RepoTweetMedia"."tweetId"
    AND clearance_rank(c.classification::text) <= clearance_rank(current_setting('app.clearance', true))))
  WITH CHECK (EXISTS (SELECT 1 FROM "RepoTweet" t JOIN "RepoCollection" c ON c.id = t."collectionId"
    WHERE t.id = "RepoTweetMedia"."tweetId"
    AND clearance_rank(c.classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY repotweetmedia_delete ON "RepoTweetMedia" FOR DELETE TO app_runtime USING (
  EXISTS (SELECT 1 FROM "RepoTweet" t JOIN "RepoCollection" c ON c.id = t."collectionId"
    WHERE t.id = "RepoTweetMedia"."tweetId"
    AND clearance_rank(c.classification::text) <= clearance_rank(current_setting('app.clearance', true))));
