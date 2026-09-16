-- Place に kind (聖地の種類) を足す
--
-- 公開サイト (sekai-nina-site) の聖地マップを作り直し、ピンを種類のアイコン
-- (グルメ / レジャー / 寺社・公園・景色 / 会場・放送局 / 店・施設) で描き分けるようにした。
-- 種類はサイト側の JSON ではなく Akashic の場所を正とする (場所の属性は Akashic に集約する方針)。
-- サイトはビルド時に GET /api/v1/places の kind を読み、null の場所だけ名前・説明から推定する。
--
-- nullable で既定値は無し (= 未設定)。既存行は null のままで、画面 / API / MCP から順次付ける。
-- Place は保護テーブルだが列追加だけなので RLS ポリシーの変更は無い。
-- 手動 GRANT は不要 (新しいテーブルは無く、列の権限はテーブル単位で付いている)。
-- 本番は SQL を先に当ててからデプロイする (nullable 列なので旧コードは影響を受けないが、
-- 新コードは列が無いと聖地の一覧・詳細が落ちる)。

-- CreateEnum
CREATE TYPE "PlaceKind" AS ENUM ('food', 'leisure', 'scenery', 'venue', 'shop');

-- AlterTable
ALTER TABLE "Place" ADD COLUMN     "kind" "PlaceKind";
