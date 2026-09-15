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

- 他メンバーのブログも坂井情報の抽出源なので、ブログのアイテムは**全記事**が母集団（絞らない）。

### パターンの OR 対応（v2.2）

`publisherPattern` / `titlePattern` は **`|` 区切りで複数の LIKE パターン**を書ける（いずれかに一致で
マッチ = OR）。番組の切り分け・雑誌の複数誌対応に必要（migration 不要のアプリ層実装）。

### ソース設定（v2.2 シード。実データ調査 2026-07-12 に基づく）

| source | itemRule | publisherPattern | titlePattern | 根拠 |
|---|---|---|---|---|
| blog | blog_url | `日向坂46公式ブログ%` | — | 13,908件 |
| talk | talk_date | `Talk (Sony Music)%` | — | 26,866件 |
| hinaai | source_url | `Lemino%` | `【%配信】#%\|%日向坂で会いましょう%\|#3__\|#4__\|#3__⏎\|#4__⏎` | 番号のみ表記(#362等)は**末尾%なしの完全長マッチ**（`#4__%` だとひななり「#4 企画名」を誤マッチ）。⏎=改行付き行対応 |
| ninarimashou | source_url | `Lemino%` | `#_ %\|#__ %\|%日向坂になりましょう%` | 「#N 企画名」形式と「日向坂になりましょう【…】#N」形式 |

| hinachan | source_url | `YouTube%` | `日向坂ちゃんねる%` | 全タイトルがこの前方一致 |
| official_ch | source_url | `YouTube%` | `日向坂46公式チャンネル%` | 同上 |
| magazine | source_url | `EX大衆%\|BRODY%\|週刊少年チャンピオン%\|グラビアチャンピオン%\|Ray%\|BUBKA%\|B.L.T.%` | — | 誌名=publisher。新誌が来たら設定タブで追記 |
| instagram / tiktok / x_official / showroom / radio | manual | — | — | **Akashic にアセット未取込**のため導出不能。取込が始まったら設定 |

実DB検証（2026-07-12）: 上記パターンで Lemino 109 URL → hinaai 57 + ninarimashou 52（**重複0・取りこぼし0**）、
YouTube 28 URL → hinachan 20 + official_ch 8（未振り分け0）、magazine 8。
将来ひななりが #300 を超える頃に `#3__` が衝突しうるが、遠い将来であり設定タブで調整可能。

- publisher/title の値には**末尾に改行が入っている行がある**（例 `Lemino\n`）。前方一致 `%` で吸収する。
- Lemino の切り分けはタイトル形式に依存しておりもろい。誤分類を見つけたら設定タブでパターンを調整する運用。

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

## 6.5 トリアージ UX（v2.2 — 人間の作業フローに合わせた再設計）

素のチェックリストは作業設計として不十分だった。実際の人間の作業（例: レジャー × 公式ブログ）は:

1. まず**坂井新奈への言及がある記事だけに絞りたい**（母集団2,274記事の大半は無関係）
2. 言及箇所の**抜粋を一覧上で読んで**当たりを付けたい
3. **ドシエに登録済みのものはそうと分かる**ようにして、済みなら軽い確認で✓
4. 未登録で中身がありそうなら、**アセットを開いて読み、ドシエ登録してから**✓

これを直接支える形にアイテム一覧を再設計する:

### アイテム行の情報設計

- 日付・タイトル（外部リンク）・現観点チェックボックス・展開で全観点（v2 のまま）
- **言及バッジ＋抜粋**: 坂井新奈エンティティ（aliases 15種: にぃたん/にーたん/新奈…）への言及有無。
  判定は (a) AssetEntity リンク（2,351件 curated 済み）**または** (b) AssetText の本文一致。
  一致箇所の前後を切り出したスニペット（複数可・一致語ハイライト）を行内に表示。
  既存 `/api/v1/entities/[id]/mentions` の実装ロジックを流用すること。
- **ドシエバッジ**: このアイテム（URL/日）に属するアセットを含むドシエの名前（`/dossiers/[id]` リンク）。
  「既に処理された器がある」ことの表示。現状 122 URL 分が該当。
- **アセット導線**: アイテムに属するアセット（件数付き）から `/assets/[id]` へ飛べる。
  未登録アイテムを開いて読む→ドシエ登録→戻って✓、の往復を最短にする。

### フィルタ・一括操作

- フィルタ: 「坂井新奈に言及あり」（**blog では既定 ON**。talk は全件本人なので非適用）・「未チェックのみ」
- **「言及なしをここまで一括✓」**（この観点 / 全観点）: 言及のない記事は「見る必要がなかった＝確認済み」
  として一掃する。退屈な9割を自動で流す最重要の省力化。
- 既存の「ここまで全部✓」も継続

### talk_date アイテムの扱い

- 言及フィルタなし（全件本人）。その日のトーク本文の**先頭スニペット**を行内プレビューして
  「何の話をした日か」を開かずに判断できるようにする。ドシエバッジ・アセット導線は同様。

## 6.6 v2.3 — アイテム主導の消化フロー（実機フィードバック反映）

v2.2 を実機で触ったフィードバック: 「タイトルは公式でなく Akashic のアセットへ」「チェックしたら
消えて（Todo型・Undo可能）」「複数観点へ一気にチェックしたい」「画像ギャラリーが見たい」
「言及なしを全部✓する機能」「日付表示が壊れている」。

作業の主単位は「観点×アイテム」ではなく**アイテム**である。1記事を読んだら関係する観点すべてに
一度にチェックし、済んだ記事は視界から消えるべき。「複数観点一気に」と「チェックで消える」の
両立は、**消える条件をモードで分ける**ことで解決する。

### 2モード制（アイテム一覧ページ）

| | 消化モード（既定・Todo型） | 観点モード（単観点スイープ） |
|---|---|---|
| 行の表示 | **全アクティブ観点のチップを常時表示**（展開不要） | 選択中観点のチェックボックスのみ |
| 消える条件 | **全アクティブ観点に✓**（=行の完了） | 選択中観点に✓ |
| 主ボタン | **「残りの観点も確認済みにする」**= 未チェック観点を一括✓して行を完了 | 行チェック |
| 用途 | 日常の新着消化・アイテム単位の精読 | 1観点で過去ログを掃くキャンペーン |

- 消えた行は **Undo トースト**（直後に1クリックで戻す）＋「完了済みを表示」トグルで復活・チェック解除可能。
- チェックの意味論は不変: ✓ = この観点で確認済み（「見たが該当なかった」を含む）。

### リンク・表示

- **タイトル → Akashic のアセットページ** `/assets/[id]`（text アセット優先の代表アセット）。
  公式原典 URL は小さい外部リンクアイコンとして併置。
- **日付は折り返し禁止**（whitespace-nowrap。v2.2 で `2025-03-⏎10` と壊れていた）。
- アセットの kind 羅列（text image image…）を廃止し、**画像アセットはサムネイルストリップ**
  （`/api/v1/assets/[id]/thumbnail` を利用。**認証必須**だが、同一オリジンの `<img>` にはセッション cookie が自動で付くので画面からはそのまま表示できる）。クリックで**ページ内ライトボックス**拡大、
  そこからアセットページへも飛べる。text はアイコン＋リンク。

### 一括

- **「言及なしを全部✓」**（全期間・全観点・ワンショット）を追加（bulk の untilDate 省略= 全期間）。
- 既存の「ここまで全部✓」「言及なしをここまで✓」は維持。

## 6.7 v2.4 — 著者軸・アセット内チェック・原寸画像（実機フィードバック第2弾）

フィードバック: 「ブログ/トークは著者を表示すべき」「アセットを開いた状態で観点チェックしたい
（一覧⇄アセットの往復が非効率）」「言及だけでなく**坂井新奈が著者**のアセットを表示できるように
（本人ブログには本人への言及が無いことがある）」「画像をもっと大きく（坂井新奈が写っているかの
判断に耐えるサイズ）」「言及なし全部✓は危険なので不要」。

実データ根拠: `AssetEntity.roleLabel='author'` がほぼ全アセット（40,586件）に付与済み。
坂井新奈が author のアセット=2,343。画像は全件 gdrive で、原寸は `/api/drive-image/[storageKey]`
（セッション認証プロキシ・アセット詳細ページと同じ経路）で配信できる。

### 1. 著者の表示と「本人著」軸

- アイテム行に**著者バッジ**（所属アセットの author エンティティ名。例「大田美月」「坂井新奈」）。
- **関連判定を2軸に**: 関連 = 言及あり **OR 坂井新奈が著者**。blog の既定フィルタは「関連のみ」。
  バッジは「言及」「本人」を区別して表示。本人著の itemKey 集合は言及キー集合と同構造でキャッシュ計算。
- **一括の安全化**: `onlyMentionless` の意味を「**関連なし**（言及なし かつ 本人著でない）」に強化し、
  ボタン文言も「関連なしをここまで✓」に変更。**「全部✓（全期間）」ボタンは削除**（誤爆リスク）。

### 2. アセットページ内の観点チェックパネル

`/assets/[id]` に**カバレッジパネル**を追加: このアセットが属するカバレッジアイテム
（ブログ記事 / トーク日 / 番組回）を逆引きし、**全アクティブ観点のチップと
「残りの観点も確認済みにする」ボタン**をその場に表示する。チェックは**アイテム単位**
（そのアセット単体ではなく記事/日の全体に付く）であることを明記。
これで「一覧→アセットを読む→観点を覚えて一覧へ戻って✓」の往復が消える。

- 逆引き domain: アセットの SourceRecord.url / canonicalDate(JST日) を、derivable な各 DataSource の
  パターンと突き合わせて所属アイテムを求める（`findItemsForAsset`）。該当なしならパネル非表示。
- 編集は admin/member のみ（既存 requireEditor 方式）。

### 3. ライトボックスの大きな表示（訂正版）

- **drive-image 原寸は使わない**（プロキシが重い。R2 サムネイルの実解像度で判定には十分）。
  enrichment への `storageKey` 追加も不要。
- ライトボックスは**既存の thumbnail API（→ R2 thumbnailUrl へ 302）の画像をそのまま大きく表示**する
  （max-width 90vw / max-height 85vh・object-fit: contain）。ストリップの小サムネと同じ URL で、
  CSS サイズだけの問題。
- 「坂井新奈が写っているか」判定に耐えるサイズ = R2 サムネの実解像度をフルに使う表示。

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
