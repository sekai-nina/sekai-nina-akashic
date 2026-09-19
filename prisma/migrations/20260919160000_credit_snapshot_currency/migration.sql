-- 残高スナップショットに「目視した通貨」を持たせる。
--
-- 社内の計算はすべて USD で持つ (単価表も各社のコスト API も USD) が、
-- Google Cloud の請求通貨はアカウントによって円で、AI Studio の残高も円で出る。
-- 円で見た額をそのまま balanceUsd に入れると残高を 150 倍に見せてしまうため、
-- 原本 (amount / currency) とレート (unitsPerUsd) を残し、balanceUsd は換算値にする。
--
-- 既存行はすべて USD として入力されていたので amount = balanceUsd / rate = 1 で埋める。
-- 既存テーブルへの列追加なので app_runtime への追加 GRANT は不要。

-- 既定値 0 は、この migration を当ててから新しいコードが出るまでの間に
-- 旧コード (amount を書かない) が insert しても落ちないようにするためのもの。
ALTER TABLE "CreditSnapshot" ADD COLUMN "amount" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "CreditSnapshot" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "CreditSnapshot" ADD COLUMN "unitsPerUsd" DECIMAL(12,4) NOT NULL DEFAULT 1;

UPDATE "CreditSnapshot" SET "amount" = "balanceUsd";
