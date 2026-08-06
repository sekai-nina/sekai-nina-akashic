-- 記事 (世界新奈) を akashic 側で扱えるようにする
--
-- 実体は別リポジトリ sekai-nina/sekai-nina-public の Markdown (333 記事)。
-- akashic の DB を編集バッファとし、溜まったら一括で GitHub へ push する
-- (= GitHub は出力先に徹する)。したがって DB が単一の真実で、frontmatter は
-- push 時に丸ごと生成する。本モデルで持たない frontmatter は
-- Article.frontmatterExtra に退避して復元する。
--
-- 変更内容:
--   1. ArticleType / ArticleSourceStatus enum
--   2. Article 新設 (非保護。公開記事のミラーなので RLS を掛けない)
--   3. ArticleSource 新設 (保護。アセット本文の抜粋を持つため RLS 込み・direct-classification)
--
-- ArticleSource の RLS は Lens/DataSource/Coverage/LensItemCheck と同形。
-- clearance_rank() は 20260511000000_add_rls 定義。
--
-- ⚠ 本番適用後の手動 GRANT が必要 (Article は RLS 対象外だが app_runtime で読むので権限は要る):
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "Article" TO app_runtime;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "ArticleSource" TO app_runtime;

-- CreateEnum
CREATE TYPE "ArticleType" AS ENUM ('attribute', 'event', 'quote', 'column', 'item', 'quiz');

-- CreateEnum
CREATE TYPE "ArticleSourceStatus" AS ENUM ('applied', 'pending', 'unresolved');

-- CreateTable
CREATE TABLE "Article" (
    "id" TEXT NOT NULL,
    "shortId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "slug" TEXT,
    "title" TEXT NOT NULL DEFAULT '',
    "type" "ArticleType",
    "tags" JSONB NOT NULL DEFAULT '[]',
    "body" TEXT NOT NULL DEFAULT '',
    "date" TIMESTAMP(3),
    "dateDisplay" TEXT,
    "dateMode" TEXT,
    "publishedAt" TIMESTAMP(3),
    "articleUpdatedAt" TIMESTAMP(3),
    "draft" BOOLEAN NOT NULL DEFAULT false,
    "unlisted" BOOLEAN NOT NULL DEFAULT false,
    "ongoing" BOOLEAN NOT NULL DEFAULT false,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "frontmatterExtra" JSONB NOT NULL DEFAULT '{}',
    "githubSha" TEXT,
    "dirty" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3),
    "lastPushedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleSource" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "assetId" TEXT,
    "status" "ArticleSourceStatus" NOT NULL DEFAULT 'pending',
    "sourceNo" INTEGER,
    "label" TEXT NOT NULL DEFAULT '',
    "url" TEXT,
    "date" TIMESTAMP(3),
    "originalRef" TEXT,
    "excerpt" TEXT NOT NULL DEFAULT '',
    "excerptType" "TextType",
    "excerptStart" INTEGER,
    "excerptEnd" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArticleSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Article_shortId_key" ON "Article"("shortId");

-- CreateIndex
CREATE UNIQUE INDEX "Article_path_key" ON "Article"("path");

-- CreateIndex
CREATE INDEX "Article_type_idx" ON "Article"("type");

-- CreateIndex
CREATE INDEX "Article_dirty_idx" ON "Article"("dirty");

-- CreateIndex
CREATE INDEX "Article_publishedAt_idx" ON "Article"("publishedAt");

-- CreateIndex
CREATE INDEX "ArticleSource_articleId_idx" ON "ArticleSource"("articleId");

-- CreateIndex
CREATE INDEX "ArticleSource_assetId_idx" ON "ArticleSource"("assetId");

-- CreateIndex
CREATE INDEX "ArticleSource_status_idx" ON "ArticleSource"("status");

-- CreateIndex
CREATE INDEX "ArticleSource_classification_idx" ON "ArticleSource"("classification");

-- AddForeignKey
ALTER TABLE "ArticleSource" ADD CONSTRAINT "ArticleSource_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleSource" ADD CONSTRAINT "ArticleSource_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 検索用の trgm インデックス (記事タイトル・本文)。既存の Asset/Entity と同形。
CREATE INDEX IF NOT EXISTS "idx_article_title_trgm" ON "Article" USING gin ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_article_body_trgm" ON "Article" USING gin ("body" gin_trgm_ops);

-- RLS (clearance ベース、fail-closed)。clearance_rank() は 20260511000000_add_rls 定義。
-- Article は公開記事のミラーなので RLS を掛けない (Entity と同じ非保護テーブル扱い)。
ALTER TABLE "ArticleSource" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ArticleSource" FORCE ROW LEVEL SECURITY;

CREATE POLICY articlesource_select ON "ArticleSource" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY articlesource_insert ON "ArticleSource" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY articlesource_update ON "ArticleSource" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY articlesource_delete ON "ArticleSource" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
