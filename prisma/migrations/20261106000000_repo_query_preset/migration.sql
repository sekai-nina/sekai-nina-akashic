-- X レポ収集の検索ワードのプリセット
--
-- ミーグリの回の画面で検索条件を選び直せるようにする。プリセットは画面から足す・直す・消す。
-- 初期データは、手で作った収集 (10/25・11/1・11/3) で実際に使っていた条件。
-- 新しいテーブルを足すだけなので、コードより先に本番へ当てる (画面が読むため)。
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "RepoQueryPreset" TO app_runtime;

-- CreateTable
CREATE TABLE "RepoQueryPreset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "groups" JSONB NOT NULL,
    "extra" TEXT NOT NULL DEFAULT '',
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepoQueryPreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RepoQueryPreset_name_key" ON "RepoQueryPreset"("name");

-- CreateIndex
CREATE INDEX "RepoQueryPreset_classification_idx" ON "RepoQueryPreset"("classification");

-- RLS
ALTER TABLE "RepoQueryPreset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RepoQueryPreset" FORCE ROW LEVEL SECURITY;

CREATE POLICY repo_query_preset_select ON "RepoQueryPreset" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY repo_query_preset_insert ON "RepoQueryPreset" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY repo_query_preset_update ON "RepoQueryPreset" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY repo_query_preset_delete ON "RepoQueryPreset" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);

-- 初期データ
INSERT INTO "RepoQueryPreset" ("id", "name", "groups", "updatedAt") VALUES
  ('preset_online', 'オンライン', '[{"tags":["坂井新奈","ミーグリ"],"op":"and"},{"tags":["坂井新奈","ミーグリレポ"],"op":"and"},{"tags":["にぃぐり"],"op":"and"}]', CURRENT_TIMESTAMP),
  ('preset_real', 'リアル', '[{"tags":["坂井新奈","ミーグリ"],"op":"and"},{"tags":["坂井新奈","リアルミーグリ"],"op":"and"},{"tags":["坂井新奈","リアミレポ"],"op":"and"},{"tags":["坂井新奈","ミーグリレポ"],"op":"and"},{"tags":["にぃぐり"],"op":"and"}]', CURRENT_TIMESTAMP);
