-- ミーグリの先送りレビュー指摘 (#112)
--
-- 1. 同じ回を二度作らない
--    作成は X の収集込みで数十秒かかることがあり、bot がタイムアウトして再送すると
--    ドシエ・収集が二重にできていた。docs で「再送しない」と書いているだけだったのを
--    DB の制約にする。同じ日に 2 回あるときは label ("通常" / "初限" / 会場名) で呼び分ける。
--    適用時点の 35 行に重複は無い (確認済み)。
--
-- 2. ドシエ削除の Cascade をやめる
--    MeetGreet はスケッチ・切り抜き枠・記事の紐づけ・除外リストを持つようになった (#108/#109/
--    #134/#136)。ドシエを消すだけで行ごと消えると、それらが復元できない。Restrict にして、
--    先にミーグリを消してもらう。
--
-- 既存テーブルへの変更のみなので手動 GRANT は不要。

CREATE UNIQUE INDEX "MeetGreet_date_format_label_key" ON "MeetGreet"("date", "format", "label");

ALTER TABLE "MeetGreet" DROP CONSTRAINT "MeetGreet_dossierId_fkey";
ALTER TABLE "MeetGreet" ADD CONSTRAINT "MeetGreet_dossierId_fkey"
  FOREIGN KEY ("dossierId") REFERENCES "Dossier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
