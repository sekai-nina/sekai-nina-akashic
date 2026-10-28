-- 記事と聖地の紐づけ (#283)。
--
-- 記事↔聖地はこれまで frontmatter の `locations` (Article.frontmatterExtra) にしか無く、
-- push でそのまま公開リポジトリに出るため、生活圏の場所のように公開サイトに出したくない
-- 聖地は記事に紐づけられなかった。紐づけの正をこのテーブルに移し、push では Place が
-- public / internal の行だけで `locations` を組み立てる。confidential 以上は akashic の中にだけ残る。
-- RLS は紐づく Place の classification に従う (AssetEntity と同形。Place 自体の RLS も効く)。
--
-- 既存の `place_id` 参照は `pnpm cli:backfill-article-places --apply` で取り込む
-- (frontmatterExtra.locations から抜き、push の出力は変えない)。
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "ArticlePlace" TO app_runtime;

CREATE TABLE "ArticlePlace" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticlePlace_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ArticlePlace_placeId_idx" ON "ArticlePlace"("placeId");
CREATE UNIQUE INDEX "ArticlePlace_articleId_placeId_key" ON "ArticlePlace"("articleId", "placeId");

ALTER TABLE "ArticlePlace" ADD CONSTRAINT "ArticlePlace_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArticlePlace" ADD CONSTRAINT "ArticlePlace_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArticlePlace" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ArticlePlace" FORCE ROW LEVEL SECURITY;

CREATE POLICY articleplace_select ON "ArticlePlace" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Place" WHERE id = "ArticlePlace"."placeId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY articleplace_insert ON "ArticlePlace" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM "Place" WHERE id = "ArticlePlace"."placeId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY articleplace_update ON "ArticlePlace" FOR UPDATE TO app_runtime
  USING (EXISTS (SELECT 1 FROM "Place" WHERE id = "ArticlePlace"."placeId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))))
  WITH CHECK (EXISTS (SELECT 1 FROM "Place" WHERE id = "ArticlePlace"."placeId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY articleplace_delete ON "ArticlePlace" FOR DELETE TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Place" WHERE id = "ArticlePlace"."placeId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
