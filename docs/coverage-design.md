# 収集状況（ソースごとの収集済みの日付・#253）

`/coverage` は「ソースごとに、いつまでの分を取り込んだか（収集済みの日付）」を管理する。2026-10-25 にユーザーと合意（[Issue #253 の合意記録](https://github.com/sekai-nina/sekai-nina-akashic/issues/253#issuecomment-6387222460)）。

| 管理するもの | 置き場所 |
|---|---|
| どこまで集めたか（収集） | `/coverage` |
| どこまで人が見たか（記事化） | `/progress` |
| 何が書いてあったか | クリップ |

## 経緯

#233 / #236 では「観点（`Lens` 9 個）× ソース（`DataSource` 12 個）」のマスごとに、人がどこまで確認したかの日付を手で入れる設計だった（[段階3の記録](./coverage-phase3-design.md)）。本番の 108 マスは一度も入力されず、公開サイトの `/status` は全部「未確認」だった。クリップを作れるようになって観点ごとのチェックは要らなくなり、人がどこまで見たかは `/progress` で管理しているため、`/coverage` は収集だけを扱うことにした。

## 収集済みの日付の出し方

### 自動（bot のハートビート）

そのソースを見ている bot が最後に正常に動いた日（`Job.lastOkAt` の JST 日付）を収集済みの日付とする。

- 投稿の無い日も「確認して何も無かった」として進む（最新アセットの日付だと、週 1 の番組や投稿の少ない SNS が全部取れていても古く見える）
- bot が止まれば日付も止まる。報告が一度も無ければ未確認
- 対応表は `src/lib/coverage/collection.ts` の `SOURCE_HEARTBEAT_JOBS`（コードの定数。`/status` の `SOURCE_FRESHNESS_MAX_AGE_HOURS` と同じ扱い）

| ソース | ハートビート |
|---|---|
| 公式ブログ (`blog`) | `bot.blog_watch` |
| トーク (`talk`) | `bot.talk_monitor` |
| 日向坂ちゃんねる (`hinachan`) / 公式チャンネル (`official_ch`) | `bot.youtube_watch` |
| TikTok (`tiktok`) | `bot.tiktok_watch` |

自動のソースは手入力できない（Server Action・REST とも拒否する）。

### 手入力

ハートビートの無いソース（ひなあい・ひななり・Instagram・X（公式）・SHOWROOM・雑誌・ラジオ）は `DataSource.collectedUntil` に手で入れる。Lemino と Instagram の収集にハートビートを足したら、対応表に 1 行加えるだけで自動に切り替わる（別 Issue）。

| 列 | 意味 |
|---|---|
| `collectedUntil` DATE null 可 | 収集済みの日付。JST の暦日を YYYY-MM-DD で受け渡す |
| `collectedUntilUpdatedAt` timestamp null 可 | 最後に設定した日時（空に戻したときも記録） |
| `collectedUntilUpdatedById` text null 可 | 最後に設定した人 |

- 有効な 1900-01-01 以降の暦日、今日（JST）以前だけを許可。2026-02-30 などの繰り上がりを拒否
- 画面の更新は admin / member の Server Action。viewer は閲覧のみ。REST は `PATCH /api/v1/datasources/:id` の `collectedUntil`（write 権限）
- `withClearance` で読み書きする。見えないソースは「見つからない」、RLS の競合は権限エラー
- migration `20261025010000_datasource_collected_until` は null 可の列追加だけ。既存テーブルの RLS / GRANT を引き継ぐため追加 GRANT は不要

## 画面と公開データ

`/coverage` は 1 ソース 1 行の表。

- ソース名・収集済みの日付（手入力のソースはクリックで日付の dialog）
- 方式: 自動 = bot 名と最終稼働日時（直近がエラーなら印）/ 手入力 = 最後の更新日時と更新者
- 最新の取り込み日と件数（参考。`DataSource.itemRule` からの導出をキャッシュ付きの `getDerivedItems` で数える。有効なソースだけ・manual は「—」。導出が冷えていると数十秒かかるので、この列だけ Suspense で後から出す。ソースの導出設定を変えるとキャッシュを捨てる）
- 「ソース管理」タブでデータソースの追加・編集（itemRule・パターン・公開・有効）

`getSummary` → `GET /api/v1/coverage/summary` → stats Worker / KV（30 分間隔）→ 公開サイト `/status`。public かつ active で classification が internal 以下のソースだけを `{ key, name, collectedUntil, auto }` で返す。手入力の設定者・設定日時は出さない。

公開サイトは「`sources` があれば新表示（ソースごとに『YYYY-MM-DD まで収集済み』、日付なしは『未確認』、自動のソースには印）、無ければ旧表示」。公開サイトを先に出してから Akashic を切り替える。

## 観点の片付け

- `/coverage` の観点・セル編集、観点の管理を撤去した
- `/api/v1/lenses*`・`GET/PUT /api/v1/coverage`・`GET /api/v1/coverage/items` は認証・権限の検証後に 410（`PUT /coverage/checks` / `POST /coverage/checks/bulk` は #233 段階3から 410）
- `getMatrix` / `upsertCell` / `listItems` などのドメイン関数も消した
- `Lens` / `Coverage` / `LensItemCheck`（164 行）のテーブルと行は残す。消すと戻せず、残しても害が無いため
- `DataSource.itemRule` と素材の導出、言及・著者の判定（`src/lib/domain/coverage-items.ts`）は `/progress` が使うので残す
- 旧 `/coverage/[sourceKey]` は、標準 12 ソースなら `/progress/materials/[sourceKey]`、独自ソースなら `/coverage` へ転送する
