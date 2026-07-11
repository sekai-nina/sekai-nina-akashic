# 収集カバレッジ管理（観点 × データソース）設計書 v2

Status: v2 設計確定（2026-07-12）/ v1（日付カーソル）は実装・本番適用済み → 本書の差分を追加実装する
Owner: tada / 設計: Claude (Fable 5)

## 0. v1 からの転換（重要）

v1 は「セルに手動の日付カーソル（collectedUntil）を持つ」設計だった。しかし運用者の実感として
**「この日付までこの観点でこのソースは OK」とは言い切れない**。言い切れる最小単位は
**「このソースのこのデータ（ブログ記事1本・トーク1日分）を、この観点で見た」**である。

よって v2 では:

- チェックの単位を **アイテム（ソースごとの投稿/ドキュメント単位）** にする
- セルの値（済/総数・「何日まで反映済み」）は **アイテムチェックからの導出値** にする（手動日付は廃止）
- 「何日まで反映できています」という表示要件は、**連続チェック済み日付の導出**で自動的に満たされる

軸は v1 のまま **観点 × データソース の2軸**（対象は坂井新奈のみ）。サイトへの控えめな公開表示も継続。

## 1. 概念定義

| 概念 | 意味 |
|---|---|
| **Lens（観点）** | 情報収集の切り口（v1 のまま。9件シード済み） |
| **DataSource** | 収集元ストリーム（v1 のまま。12件シード済み）。v2 で**アイテム導出規則**を持つ |
| **アイテム** | チェックの最小単位。**テーブル実体化しない**（導出ビュー）。ブログ=記事1本（URL）、トーク=1日分、番組=1回（URL） |
| **LensItemCheck** | 「このアイテムをこの観点で見た」の記録（v2 新設・本体） |
| **Coverage** | v1 のセルテーブル。**セル注記（対象外マーク・メモ）専用に格下げ**。`collectedUntil` は削除 |

## 2. アイテム導出規則（itemRule）

実データ調査（2026-07-12, 本番）: Asset 約4万件。`SourceRecord.publisher` が事実上のソース判別子
（`Talk (Sony Music)`=26,866 / `日向坂46公式ブログ`=13,908 / Lemino ~109 / YouTube 28 / 雑誌 数件）。

`DataSource` に以下を追加:

- `itemRule: ItemRule` — `blog_url` | `talk_date` | `source_url` | `manual`
- `publisherPattern: String?` — SourceRecord.publisher への SQL LIKE（null=不問）
- `titlePattern: String?` — SourceRecord.title への SQL LIKE（null=不問）。番組の切り分け用

| itemRule | アイテム | itemKey | itemDate | itemTitle |
|---|---|---|---|---|
| `blog_url` | publisher が一致する SourceRecord の **distinct url** = 記事1本 | url | 当該 url の Asset.canonicalDate の min（無ければ publishedAt） | SourceRecord.title |
| `talk_date` | publisher が一致する Asset の **canonicalDate の日単位 distinct** | `YYYY-MM-DD` | その日 | `トーク YYYY-MM-DD` |
| `source_url` | pattern が一致する SourceRecord の distinct url（番組回・動画単位） | url | 同上 | SourceRecord.title |
| `manual` | 導出なし（空リスト）。アセット未取込ソースの暫定値 | — | — | — |

- シードでの設定: `blog` → blog_url + `日向坂46公式ブログ`、`talk` → talk_date + `Talk (Sony Music)`。
  確度の低いもの（hinaai 等）は当面 `manual` とし、管理 UI から itemRule/pattern を設定できるようにする。
- 他メンバーのブログも坂井情報の抽出源なので、ブログのアイテムは**全記事**が母集団（絞らない）。

## 3. データモデル（v2 差分）

```prisma
enum ItemRule {
  blog_url
  talk_date
  source_url
  manual
}

// DataSource に追加:
//   itemRule         ItemRule @default(manual)
//   publisherPattern String?
//   titlePattern     String?

model LensItemCheck {
  id             String         @id @default(cuid())
  lensId         String
  lens           Lens           @relation(fields: [lensId], references: [id], onDelete: Cascade)
  dataSourceId   String
  dataSource     DataSource     @relation(fields: [dataSourceId], references: [id], onDelete: Cascade)
  itemKey        String         // url または "YYYY-MM-DD"
  itemDate       DateTime?      // 導出時点のスナップショット（表示・連続日付導出用）
  itemTitle      String?        // 表示用スナップショット
  note           String?
  classification ClearanceLevel @default(internal)
  checkedById    String?
  checkedAt      DateTime       @default(now())

  @@unique([lensId, dataSourceId, itemKey])
  @@index([dataSourceId, itemDate])
  @@index([classification])
}

// Coverage は残すが collectedUntil カラムを削除（セル注記=not_applicable/note 専用）
```

- RLS: `LensItemCheck` に Place/RepoCollection と同じ direct-classification パターン
  （ENABLE+FORCE、app_runtime 4ポリシー、clearance_rank 判定）を**同一 migration 内で**張る。
- 本番適用後の手動 GRANT が必要: `GRANT SELECT, INSERT, UPDATE, DELETE ON "LensItemCheck" TO app_runtime;`
- migration: `20260712010000_item_checks`（ALTER DataSource / CREATE LensItemCheck / Coverage.collectedUntil DROP）。
  v1 の Coverage データは本番に存在しない（セル0件）ため破壊なし。

## 4. 導出値の定義（domain）

セル (lens × source) ごとに:

- `totalItems` — 導出アイテム総数（lens に依らずソースで共通）
- `checkedItems` — LensItemCheck の件数（導出アイテムと itemKey が一致するもの）
- `continuousUntil` — **「この日まで全部見た」と言える導出日付**:
  itemDate 昇順で見て、最古の未チェックアイテムの**直前のアイテムの日付**。
  未チェックが無ければ最新アイテムの日付。先頭から未チェックなら null。
- `lastCheckedAt` — 最終チェック日時（活動の目安）

実装ノート: マトリクスは **セルごとの N+1 クエリ禁止**。ソース別アイテム集計＋
(lens×source) 別チェック集計を各1回の集約 SQL（$queryRaw）で取り、アプリ側で結合する。
`continuousUntil` は「ソース別の日付昇順アイテム列」と「チェック済み itemKey 集合」から計算する
（アイテム数はブログ~数千・トーク~500日程度なので全件メモリで問題ない。必要なら SQL 化）。

## 5. API（v2 差分）

| エンドポイント | メソッド | 権限 | 内容 |
|---|---|---|---|
| `/api/v1/coverage` | GET | read | マトリクス（導出値入りセル）。`?public=1` 対応は継続 |
| `/api/v1/coverage/items` | GET | read | アイテム一覧。`?source=blog&lens=food&checked=0&order=asc&page=` 。lens 省略時は**全観点のチェック状態フラグ付き**で返す（アイテム起点ビュー用） |
| `/api/v1/coverage/checks` | PUT | write | チェックのトグル `{lensKey, dataSourceKey, itemKey, checked}`（冪等 upsert / delete） |
| `/api/v1/coverage/checks/bulk` | POST | write | 範囲一括 `{dataSourceKey, lensKeys[], untilDate}` — itemDate <= untilDate の全導出アイテムを対象 lens でチェック済みに（createMany skipDuplicates） |
| `/api/v1/coverage/summary` | GET | read | サイト用要約。`collectedUntil` の代わりに導出 `continuousUntil` と `checked/total` を返す |
| `/api/v1/lenses` ほか v1 の CRUD | — | — | 継続。DataSource PATCH で itemRule/pattern を編集可能に |

Coverage セルの PUT（v1）は「status=not_applicable / note」のみに縮退（collectedUntil 受付を廃止）。

summary 形（Phase 2 サイト連携用）:

```json
{
  "generatedAt": "...",
  "lenses": [{
    "key": "food", "name": "食べたもの",
    "sources": [{"key": "blog", "name": "公式ブログ",
                 "continuousUntil": "2026-06-25", "checked": 120, "total": 150}],
    "minContinuousUntil": "2026-05-30"
  }]
}
```

## 6. UI（v2・`/coverage`）

**マトリクス**（既存ページを改修）:
- セル表示: `済/総`（例 `120/150`）＋ 導出 `〜6/25済` の小さな添字。not_applicable はグレー「—」。
  manual で total=0 のソースは「アイテム未定義」表示。
- セルをタップ → **アイテム一覧ページ**へ遷移（`/coverage/[sourceKey]?lens=<lensKey>`）。

**アイテム一覧ページ**（新設・v2 の主戦場）:
- ヘッダ: ソース名＋観点タブ（切替可能）＋進捗（済/総・continuousUntil）
- リスト: itemDate **昇順**が既定（「ここまで✓」の直感に合わせる。降順トグルあり）。
  未チェック行を強調。各行: 日付・タイトル（url アイテムはリンク）・**選択中観点のチェックボックス**
- **行の展開 = アイテム起点ビュー**: その行に**全観点のチェックボックスが横に並ぶ**。
  1記事読んだら「食べたもの✓ レジャー✓ 良い言葉✓」を同時に付ける実作業に対応（最重要動線）
- **範囲一括**: 行のメニューから「ここまで全部✓（この観点）」「ここまで全部✓（全観点）」
  （= その行の itemDate 以前を bulk チェック。確認ダイアログ付き）
- viewer は閲覧のみ（既存の canEdit 方式）

**設定タブ**: 既存に加え、DataSource の itemRule / publisherPattern / titlePattern を編集可能に。

## 7. サイト側（Phase 2・変更なしで成立）

`sync:coverage` → summary JSON → `/status` ページ。表示は「観点ごとに 各ソース〜◯日まで確認済み
（済/総）」。v1 計画から summary のフィールド名が変わるのみ。

## 8. 運用フロー

- **日常**: 新着ブログ/トークを読む → アイテム一覧で該当行を展開し、見た観点に✓（または全観点✓）
- **過去分の消化**: 観点を決めてリストを昇順に潰す → 区切りで「ここまで全部✓」
- **将来 bot**: パイプライン完了時に `/coverage/checks` を叩いて自動チェック、停滞セルの Discord 通知

## 9. 実装タスク（Phase 1.5 = v2 差分）

1. **schema/migration**: ItemRule enum・DataSource 3カラム追加・LensItemCheck 新設（RLS込み手書きSQL）・Coverage.collectedUntil 削除
2. **seed 更新**: blog/talk に itemRule/publisherPattern を設定（既存行も upsert で更新されること）
3. **domain**: アイテム導出（itemRule 別）・セル導出値・checks upsert/delete・bulk・summary v2
4. **API**: items / checks / checks-bulk 追加、coverage GET/summary 改修、DataSource PATCH 拡張
5. **UI**: マトリクスセル改修＋アイテム一覧ページ新設＋設定タブ拡張
6. **docs**: api.md 更新

受け入れ基準: v1 と同じ（prisma validate / generate / typecheck / build、DB 非接続）。

## 10. 非スコープ

- 人物軸の追加（坂井新奈のみ）
- manual ソースへの手動アイテム登録 UI（将来。まずは itemRule 設定で吸収）
- RepoTweet（レポ収集）のアイテム化 — 別系統の選別フローが既にあるため対象外
