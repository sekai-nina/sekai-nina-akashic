-- 今日の発見の食べ物の分類 (#432)。サイトの「今日の発見ノート」で、材料・なりたい味のチップを
-- 果物 / 野菜 / 甘いもの / 主食・おかず / 乳製品 / 調味料 / 飲み物 の見出しごとに並べる (回数順だけでは選びにくかった)。
-- DiscoveryFood: 食べ物の名前 (材料・できあがる味) → 分類。
-- 非保護テーブル (一般の食べ物の名前と分類だけで、どのブログに出たかは持たない)。ただし Supabase の公開 API
-- (anon / authenticated) から触れないよう RLS を有効にし、app_runtime にだけ素通しのポリシーを付ける。
-- app_internal / akashic_cli は RLS をバイパスする。
-- ⚠ 本番適用後に app_runtime の権限を確かめる (既定権限で付くはず。無ければ):
--   GRANT SELECT, INSERT, UPDATE, DELETE ON "DiscoveryFood" TO app_runtime;

-- CreateEnum
CREATE TYPE "FoodCategory" AS ENUM ('fruit', 'vegetable', 'sweet', 'dish', 'dairy', 'seasoning', 'drink');

-- CreateTable
CREATE TABLE "DiscoveryFood" (
    "name" TEXT NOT NULL,
    "category" "FoodCategory" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveryFood_pkey" PRIMARY KEY ("name")
);

ALTER TABLE "DiscoveryFood" ENABLE ROW LEVEL SECURITY;
CREATE POLICY discoveryfood_app_runtime ON "DiscoveryFood" FOR ALL TO app_runtime USING (true) WITH CHECK (true);
