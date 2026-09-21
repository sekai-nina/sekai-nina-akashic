-- TiktokVideo に「登録できたら Discord に流すか」を持たせる (#179 レビュー指摘)
--
-- backfill や画面の「取り込む」で pending に戻した過去動画を、常駐の daemon も拾って
-- Discord に流してしまっていた (どの経路で pending になったかを行が覚えていなかった)。
-- 新着として見つけた行だけ true にし、初回接触で飛ばした行は pending に戻っても false のまま。
--
-- 既存テーブルへの列追加のみ (既定値あり) なので手動 GRANT は不要。

ALTER TABLE "TiktokVideo" ADD COLUMN "notify" BOOLEAN NOT NULL DEFAULT true;
