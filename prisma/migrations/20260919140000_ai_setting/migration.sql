-- 案内AI「ふぃたん」の運転スイッチ
--
-- サイトの表示はビルド時に焼き込まれるので、止めたいときに作り直していては間に合わない
-- （ビルドに10分以上かかる）。Worker がこの行を見に来る形にして、Akashic から即座に
-- 止められるようにする。無効にすると、回答を止めたうえでサイトから入口ごと消える。
--
--   - 行は1つだけ（id = 'singleton'）
--   - Worker は短いキャッシュを持ち、Akashic が落ちていても最後に読めた値で動き続ける
--     （これが原因で AI が止まることはない）
--   - 行が無いときは「有効」として扱う（入れ忘れで止まらないように）
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "AiSetting" TO app_runtime;

-- CreateTable
CREATE TABLE "AiSetting" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',

    CONSTRAINT "AiSetting_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "AiSetting" ADD CONSTRAINT "AiSetting_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS (clearance ベース、fail-closed)。clearance_rank() は 20260511000000_add_rls 定義。
ALTER TABLE "AiSetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiSetting" FORCE  ROW LEVEL SECURITY;

CREATE POLICY aisetting_select ON "AiSetting" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY aisetting_insert ON "AiSetting" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY aisetting_update ON "AiSetting" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY aisetting_delete ON "AiSetting" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
