-- #233 段階3: 観点×データソースの鮮度日付を直接管理する。
-- 既存 Coverage の RLS / app_runtime CRUD 権限を引き継ぐ。新規テーブル・追加 GRANT は不要。
-- freshnessUpdatedAt が null の間は従来の日付を読み取り導出するため、バックフィル不要。
-- LensItemCheck の行は変更・削除しない。本番への適用はユーザー承認後。
ALTER TABLE "Coverage"
  ADD COLUMN "confirmedUntil" DATE,
  ADD COLUMN "freshnessUpdatedAt" TIMESTAMP(3);
