-- スケッチ生成を画面から調整できるようにする (#136)
--
-- 1. MeetGreet.sketchCrops
--    ツーショットの写真をそのまま参照に渡すと隣の人の服を拾う。本人だけを送れるよう、
--    切り抜き枠を回ごとに覚える。`{ "<assetId>": { x, y, w, h } }` の**割合 (0〜1)**。
--    画面はサムネイル、生成は Drive の原本 (1280px) と解像度が違うので画素では合わない。
--    切り抜いた画像は保存せず、生成のたびに sharp で切り出す (アセットを増やさない)。
--
-- 2. SketchSetting
--    プロンプト本体と画風の見本が埋め込みで、直すのにデプロイが要った。全体で 1 行だけ持ち、
--    空なら組み込みの既定を使う (入れ忘れで生成が止まらないように)。
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "SketchSetting" TO app_runtime;

ALTER TABLE "MeetGreet" ADD COLUMN "sketchCrops" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "SketchSetting" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "prompt" TEXT NOT NULL DEFAULT '',
    "styleReferenceKey" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',

    CONSTRAINT "SketchSetting_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SketchSetting_classification_idx" ON "SketchSetting"("classification");

ALTER TABLE "SketchSetting" ADD CONSTRAINT "SketchSetting_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS (direct-classification パターン。AiSetting と同じ)
ALTER TABLE "SketchSetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SketchSetting" FORCE ROW LEVEL SECURITY;

CREATE POLICY sketchsetting_select ON "SketchSetting" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY sketchsetting_insert ON "SketchSetting" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY sketchsetting_update ON "SketchSetting" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY sketchsetting_delete ON "SketchSetting" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
