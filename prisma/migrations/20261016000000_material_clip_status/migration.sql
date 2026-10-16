-- 素材のクリップ進捗 (#233)。記事化の ArticleProgress とは別の共有の印を保存する。
-- 本番未適用。ユーザーの承認後に適用する。
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "MaterialClipStatus" TO app_runtime;

-- CreateTable
CREATE TABLE "MaterialClipStatus" (
    "id" TEXT NOT NULL,
    "dataSourceKey" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "included" BOOLEAN NOT NULL DEFAULT false,
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialClipStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MaterialClipStatus_classification_idx" ON "MaterialClipStatus"("classification");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialClipStatus_dataSourceKey_itemKey_key" ON "MaterialClipStatus"("dataSourceKey", "itemKey");

-- AddForeignKey
ALTER TABLE "MaterialClipStatus" ADD CONSTRAINT "MaterialClipStatus_dataSourceKey_fkey" FOREIGN KEY ("dataSourceKey") REFERENCES "DataSource"("key") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "MaterialClipStatus" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MaterialClipStatus" FORCE ROW LEVEL SECURITY;

CREATE POLICY materialclipstatus_select ON "MaterialClipStatus" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY materialclipstatus_insert ON "MaterialClipStatus" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY materialclipstatus_update ON "MaterialClipStatus" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY materialclipstatus_delete ON "MaterialClipStatus" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);

-- 新規テーブルの PostgREST 公開を多層で防ぐ。
REVOKE ALL ON TABLE "MaterialClipStatus" FROM anon, authenticated;

-- 登録済み URL を素材として導出する。ラジオはアプリ側で出演一覧の表から導出する。
-- X 公式と一般の X 言及を混ぜないため、公式であることを publisher に明示する。
UPDATE "DataSource" SET "itemRule" = 'source_url', "publisherPattern" = 'Instagram%', "titlePattern" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE key = 'instagram';
UPDATE "DataSource" SET "itemRule" = 'source_url', "publisherPattern" = 'TikTok%', "titlePattern" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE key = 'tiktok';
UPDATE "DataSource" SET "itemRule" = 'source_url', "publisherPattern" = 'SHOWROOM%', "titlePattern" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE key = 'showroom';
UPDATE "DataSource" SET "itemRule" = 'source_url', "publisherPattern" = 'X（公式）%|X (公式)%|日向坂46公式X%', "titlePattern" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE key = 'x_official';
