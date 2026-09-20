-- Live のドシエ削除の Cascade をやめる (#149 レビュー)
--
-- 20260921000000_live は MeetGreet の旧設計 (Cascade) をなぞっていたが、MeetGreet は
-- 20260920160000_meetgreet_unique_and_restrict (#112) で Restrict に変わっている。Live は
-- スケッチ・除外リストに加えて手入力の公演・披露曲 (LivePerformance / LiveSong は Live から
-- CASCADE) まで持つので、ドシエを消すだけで行ごと消えると被害がミーグリより大きい。
-- Restrict にして、先にライブを消してもらう (deleteDossier 側で日本語のエラーにする)。
--
-- 既存テーブルへの変更のみなので手動 GRANT は不要。

ALTER TABLE "Live" DROP CONSTRAINT "Live_dossierId_fkey";
ALTER TABLE "Live" ADD CONSTRAINT "Live_dossierId_fkey"
  FOREIGN KEY ("dossierId") REFERENCES "Dossier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
