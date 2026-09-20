-- insta-watch が使う Instagram アカウントを Akashic から見られるようにする。**1 行だけ。**
--
-- パスワードは持たない。認証情報は bot サーバの .env にだけ置き、初回ログインは人が
-- `insta-watch login --headful` で行う。ここが持つのは「どの垢か」「セッションが
-- 生きているか」だけで、ssh しなくても状態が分かるようにするのが目的。
--
-- ⚠ 本番適用後の手動 GRANT が必要:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "InstaAccount" TO app_runtime;

CREATE TABLE "InstaAccount" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "username" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "sessionValid" BOOLEAN NOT NULL DEFAULT false,
    "sessionCheckedAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "lastError" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    "classification" "ClearanceLevel" NOT NULL DEFAULT 'internal',
    CONSTRAINT "InstaAccount_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "InstaAccount" ADD CONSTRAINT "InstaAccount_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "InstaAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InstaAccount" FORCE ROW LEVEL SECURITY;

CREATE POLICY insta_account_select ON "InstaAccount" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY insta_account_insert ON "InstaAccount" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY insta_account_update ON "InstaAccount" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY insta_account_delete ON "InstaAccount" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
