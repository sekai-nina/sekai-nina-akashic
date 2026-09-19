-- 記念日 (初めて〇〇した日) の器 Anniversary を足す (#138)
--
-- 公開サイト (sekai-nina-site#27) の「今日は〇〇の日」と記念日ページの正。366 日を埋めるのが
-- 目標で、記録はブログ / トークを読んでいる最中に起きるので、出典アセットをその場で
-- 紐づけられる形にする。聖地 (Place) と同じく公開サイトはビルド時に API から取得する。
--
--   - date は JST の "YYYY-MM-DD" 文字列 (MeetGreet.date と同じ TZ 事故回避)。月日が毎年の
--     記念日、年が「〇年前」の計算に使う
--   - Asset / Article は SET NULL (出典や記事が消えても記念日は残す)
--   - 保護テーブル。classification の direct-classification RLS (Place / MeetGreet と同形)
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "Anniversary" TO app_runtime;
--
-- 本番は SQL (+ GRANT) を先に当ててからデプロイする (新コードは /anniversaries がテーブル無しで
-- 落ちる。旧コードは新テーブルを参照しないので先に当てても影響なし)。

-- CreateTable
CREATE TABLE "Anniversary" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "assetId" TEXT,
    "sourceUrl" TEXT,
    "articleId" TEXT,
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Anniversary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Anniversary_date_idx" ON "Anniversary"("date");

-- CreateIndex
CREATE INDEX "Anniversary_assetId_idx" ON "Anniversary"("assetId");

-- CreateIndex
CREATE INDEX "Anniversary_articleId_idx" ON "Anniversary"("articleId");

-- CreateIndex
CREATE INDEX "Anniversary_classification_idx" ON "Anniversary"("classification");

-- AddForeignKey
ALTER TABLE "Anniversary" ADD CONSTRAINT "Anniversary_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Anniversary" ADD CONSTRAINT "Anniversary_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS (clearance ベース、fail-closed)。clearance_rank() は 20260511000000_add_rls 定義。
ALTER TABLE "Anniversary" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Anniversary" FORCE  ROW LEVEL SECURITY;

CREATE POLICY anniversary_select ON "Anniversary" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY anniversary_insert ON "Anniversary" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY anniversary_update ON "Anniversary" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY anniversary_delete ON "Anniversary" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
