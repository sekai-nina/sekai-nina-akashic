-- タグに区分 (tagGroup) を足す。
--
-- ゲームのカード名タグ (ひなこい 286 件・UNI'S ON AIR 22 件) が一般タグと同じ
-- 選択肢に並び、「日向坂で会いましょう」などよく使う番組タグが埋もれていた。
-- 区分で検索画面のプルダウンを分ける。null は一般タグ。
--
-- 既存タグは出典から振り分ける: 紐づくアセットが 1 件以上あり、その**すべて**が
-- 同じゲームの source エンティティに紐づくタグだけをそのゲームに入れる。
-- 両方のゲームにまたがる「カードイラスト」や、大半が別出典の「トーク」は一般のまま。
--
-- Entity は既存テーブルへの列追加なので手動 GRANT は不要。

CREATE TYPE "TagGroup" AS ENUM ('hinakoi', 'unis_on_air');

ALTER TABLE "Entity" ADD COLUMN "tagGroup" "TagGroup";

UPDATE "Entity" t
SET "tagGroup" = g.grp::"TagGroup"
FROM (VALUES ('ひなこい', 'hinakoi'), ('UNI''S ON AIR', 'unis_on_air')) AS g(source_name, grp)
WHERE t.type = 'tag'
  AND EXISTS (SELECT 1 FROM "AssetEntity" ae WHERE ae."entityId" = t.id)
  AND NOT EXISTS (
    SELECT 1
    FROM "AssetEntity" ae
    WHERE ae."entityId" = t.id
      AND NOT EXISTS (
        SELECT 1
        FROM "AssetEntity" se_link
        JOIN "Entity" se ON se.id = se_link."entityId"
        WHERE se_link."assetId" = ae."assetId"
          AND se.type = 'source'
          AND se."canonicalName" = g.source_name
      )
  );
