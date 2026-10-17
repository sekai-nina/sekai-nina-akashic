# 公開サイトの鮮度管理（#233 段階3）

`/coverage` は公開サイトの「観点ごとに、各情報源をどこまで確認・反映したか」を管理する。素材をクリップし切ったかは `/progress` の別の印。観点ごとのアイテムチェックと確認済み件数の割合表示は終了する。

2026-10-18 にユーザーと「観点 × データソースごとの確認済み日付を直接更新する」方針を合意。経緯・実装と適用手順は [段階3の記録](./coverage-phase3-design.md)。

## 保存先

既存 `Coverage` の `(lensId, dataSourceId)` 一意制約を使う。行列・対象外・メモ・機密・操作者を既に持つため、新しい独立テーブルは作らない。

| 列 | 意味 |
|---|---|
| confirmedUntil DATE nullable | 確認済み日付。JST の暦日を YYYY-MM-DD で受け渡す |
| freshnessUpdatedAt timestamp nullable | 明示設定した日時。日付を空に戻した場合も非null |
| status | tracked / not_applicable。対象外は公開要約に含めない |
| note | 内部メモ。公開要約に含めない |
| classification / updatedById / updatedAt | 機密・操作者・レコード更新日時 |

日付に null だけを使うと、初回未入力と「未確認に戻す」を区別できない。freshnessUpdatedAt が null の間だけ、可視の旧 LensItemCheck と導出素材から従来の日付を表示する。入力後は confirmedUntil を使い、null なら未確認とする。メモだけの API 更新はこの切り替えを行わない。

旧記録は保存し、バックフィルや別の印への移行をしない。未編集期間中の旧日付は、従来どおり素材の追加・修正でも変わりうる。日付入力後は素材の増減で変わらない。

## 日付・認可

- 有効な1900-01-01以降の暦日、今日（JST）以前だけを許可。2026-02-30などの繰り上がりを拒否。
- 旧日付は、日付のある導出素材を昇順に並べ、最初の未確認日より前の最後の確認済み日。同日に未確認が一件あればその日全体を進めない。先頭が未確認なら null。
- 画面の更新は admin / member の Server Action。viewer は閲覧のみ。REST 更新は既存の write 権限。
- すべて withClearance。既存の direct-classification RLS4種と ENABLE/FORCE を継承。
- 更新は親 Lens・DataSource・既存行の最大機密を保持し、assertClearance を通す。同じセルの初回保存も advisory lock で直列化。
- 見えない行との一意制約/RLS競合は安全な権限エラーにする。高権限クライアントで存在確認をしない。

## UI と公開データ

`/coverage` のセルは日付・未確認・対象外だけを表示し、クリックで日付/対象外/内部メモの dialog を開く。公開前提の更新である旨を画面に示す。既存の観点・データソース管理は残す。

アセット詳細の観点チップは撤去。旧 `/coverage/[sourceKey]` は、標準12ソースなら `/progress/materials/[sourceKey]`、独自ソースなら `/coverage` へ転送する。どちらも認証と可視性を確認する。

`getSummary` → `/api/v1/coverage/summary` → stats Worker/KV（30分間隔）→ 公開サイト `/status`。要約の `continuousUntil` というキー名を維持し、件数を外す。public かつ active な観点・ソースだけで、not_applicable は除外。素材がないソースも日付管理可能。未設定は null。最小日付は一つでもnullがあればnull。

公開サイトは新旧APIの continuousUntil のみを使い、日付なしは未確認と表示する。表示の更新日時も JST。動的DOMへのCSSは `.status-page` 配下のglobalスタイルで適用。

## 旧APIと素材導出

- GET `/coverage/items` は過去チェックの読み取り互換として維持。
- PUT `/coverage/checks` / POST `/coverage/checks/bulk` は認証・write 検証後410。旧書き込み関数・Server Actionは撤去。
- DataSource.itemRule は `/progress` でも使うため残す。blog_url はブログURL、talk_date はトークのJST日、source_url は登録URL、manual は導出なし。
- publisherPattern / titlePattern は SourceRecord に対する SQL LIKE。null は不問、`|` は OR。
- Instagram / TikTok / SHOWROOM / X公式の source_url 化は段階1で本番適用済み。ラジオは `/progress` 側で年度別出演一覧の行から導出する。
- 著者 ∪ 言及の判定は coverage-items.ts に残す。MaterialClipStatus から公開鮮度を導出しない。

## 性能と適用

旧チェックは未編集セルについて一括取得。チェックのないソースは素材導出しない。チェックがあるソースは一ソース一回、最大3並列で既存キャッシュ付き getDerivedItems を利用する。全セルを入力すれば旧チェックと素材の導出は不要になる。

migration `20261018000000_coverage_freshness` は nullable 2列追加だけ。2026-10-18 にユーザー承認を受け本番適用済み。既存テーブルのRLS/GRANTを引き継ぐため追加GRANTなし。schema同士の migrate diff とローカルPostgreSQLで検証する。本番適用履歴・型・RLS・権限・既存行数の保持と新コードの読み取りを確認済み。

公開サイトを先に更新し、その後に後方互換の列追加、最後にAkashic新コードを適用する。詳細は [段階3の記録](./coverage-phase3-design.md)。
