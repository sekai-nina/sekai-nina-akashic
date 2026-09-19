-- 非保護テーブルから anon / authenticated の権限を剥がす (#117 のレビューで発覚)
--
-- Supabase は public スキーマの全テーブルに anon / authenticated への DML を既定で与え、
-- PostgREST (`/rest/v1/<table>`) がそれをそのまま外に出す。**保護テーブルが守られているのは
-- RLS のおかげであって権限のおかげではない** (ポリシーが `TO app_runtime` なので、他のロールは
-- どのポリシーにも一致せず 0 行になる)。
--
-- RLS を張っていない非保護テーブルにはその守りが無く、ブラウザに配られる publishable key で
-- 読み書きできてしまう。本番で確認した実害:
--   - `GET /rest/v1/StatusCheckState` が 200 で中身を返す
--   - `CreditSnapshot` に INSERT できれば残高を 0 に見せかけて Discord に誤報を出せる
--
-- akashic は PostgREST を使わない (Prisma が app_runtime で直接つなぐ) ので、これらのテーブルの
-- anon / authenticated 権限は不要。剥がす。app_runtime の権限はそのまま。
--
-- 対象は #100 と #117 で足した運用テーブルだけに絞る。`Article` も同じ状態だが、公開サイト側が
-- PostgREST を使っていないかの確認が要るので別 Issue にする。
--
-- ⚠ 本番では SQL を先に当てる (アプリの挙動は変わらない)。新しいテーブルを足すときも
--    Supabase の既定で再び権限が付くので、非保護テーブルには毎回これを書く。

REVOKE ALL ON TABLE
  "LlmUsageDaily", "LlmCostDaily", "CreditSnapshot",
  "Job", "JobRun", "StatusCheckState"
FROM anon, authenticated;
