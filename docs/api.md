# Akashic REST API v1

Akashicのデータを外部システムから操作するためのREST API。

> AI アシスタントから使う場合は、同じ API キーで叩ける **MCP サーバー**がある → [docs/mcp.md](./mcp.md)

## Base URL

```
http://<host>:3000/api/v1
```

## 認証

すべてのリクエストに `Authorization` ヘッダーが必要。

```
Authorization: Bearer ak_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

APIキーは `pnpm cli:keygen <user-email> <key-name>` で発行する。キーは発行時に一度だけ表示され、以降は復元できない。

### パーミッション

キーには `read` と `write` のパーミッションがある（デフォルトは両方付与）。

- `read`: GET系のエンドポイント
- `write`: POST / PATCH / ファイルアップロード

### エラーレスポンス

```json
{ "error": "Invalid or missing API key" }   // 401
{ "error": "Missing permission: write" }     // 403
```

---

## エンドポイント一覧

| メソッド | パス | パーミッション | 説明 |
|---------|------|-------------|------|
| GET | `/assets` | read | アセット一覧 |
| POST | `/assets` | write | アセット作成 |
| GET | `/assets/:id` | read | アセット詳細 |
| PATCH | `/assets/:id` | write | アセット更新 |
| GET | `/assets/:id/thumbnail` | セッション or read | サムネイルへ 302 リダイレクト（`<img>` 埋め込み用。同一オリジンの `<img>` はセッション cookie で通る。clearance の RLS 適用。サムネイルが無ければ 404） |
| GET | `/assets/search` | read | 全文検索 |
| GET | `/entities` | read | エンティティ一覧・検索 |
| POST | `/entities` | write | エンティティ作成 |
| GET | `/places` | read | 聖地一覧（緯度経度・住所・種類） |
| POST | `/places` | write | 聖地作成 |
| GET | `/places/:id` | read | 聖地詳細 |
| PATCH | `/places/:id` | write | 聖地更新 |
| DELETE | `/places/:id` | write | 聖地削除 |
| POST | `/upload` | write | ファイルアップロード |
| GET | `/lenses` | read | 観点一覧 |
| POST | `/lenses` | write | 観点作成 |
| PATCH | `/lenses/:id` | write | 観点更新 |
| GET | `/datasources` | read | データソース一覧 |
| POST | `/datasources` | write | データソース作成 |
| PATCH | `/datasources/:id` | write | データソース更新 |
| GET | `/coverage` | read | カバレッジ・マトリクス（導出値入りセル） |
| PUT | `/coverage` | write | セル注記 upsert（not_applicable / note） |
| GET | `/coverage/items` | read | ソースのアイテム一覧 |
| PUT | `/coverage/checks` | write | アイテムチェックのトグル |
| POST | `/coverage/checks/bulk` | write | 範囲一括チェック |
| GET | `/coverage/summary` | read | 公開サイト用の要約 |
| GET | `/articles` | read | 記事一覧（`hasPending=true` で未反映の紐づけがある記事） |
| GET | `/articles/:shortId` | read | 記事詳細（本文・frontmatter・出典） |
| PATCH | `/articles/:shortId` | write | 記事の部分更新（`updatedAt` 必須の楽観ロック） |
| POST | `/articles/:shortId/sources/:sourceId/apply` | write | 紐づけを反映済みにする（公開判断。internal 以下のみ） |
| POST | `/jobs/:key/runs` | write | ハートビート（bot / ワーカーのジョブが実行結果を報告する） |
| GET | `/meetgreets` | read | ミーグリ（記事ワークフロー）一覧と進み具合 |
| POST | `/meetgreets` | write | ミーグリ作成（ドシエと X レポ収集を自動作成し収集を 1 回実行、素材候補を返す） |
| GET | `/meetgreets/:id` | read | ミーグリ詳細 + 素材候補 |
| PATCH | `/meetgreets/:id` | write | シングル名・呼び分け・スケッチ追加指示の更新 |
| POST | `/meetgreets/:id/materials` | write | 素材候補のチェック結果をドシエに反映 |
| POST | `/meetgreets/:id/reports` | write | X レポの再収集 |

---

### 機密レベル (`classification`) の変更制限

API キーからは **引き上げしかできない。** `PATCH /assets/:id` と `PATCH /places/:id` に現在より低い `classification` を渡すと `403 {"error":"Cannot lower classification (<現在> -> <指定>) via API key"}` を返す。

`assertClearance` は「自分のクリアランスより上を付ける」操作しか止めず、引き下げ (例: `restricted` → `public`) は素通りするため。API キーは MCP（LLM がツールを呼ぶ経路）と共通なので、アプリ層で塞いでいる。引き下げは画面から人間が行う。

**例外は `POST /articles/:shortId/sources/:sourceId/apply`。** 記事の紐づけを反映済みにする操作は、その出典を公開リポジトリの frontmatter に載せる = `ArticleSource` の classification を `public` に下げる操作そのもので、これが API の目的なので許している。ただし **`internal` 以下の出典に限る**（`confidential` / `restricted` は 403。画面から人間が行う）。

## Assets

### GET /assets

アセットの一覧を取得する。

**クエリパラメータ:**

| パラメータ | 型 | デフォルト | 説明 |
|-----------|-----|----------|------|
| `status` | string | - | `inbox`, `triaging`, `organized`, `archived` |
| `kind` | string | - | `image`, `video`, `audio`, `text`, `document`, `other` |
| `trustLevel` | string | - | `unverified`, `low`, `medium`, `high`, `official` |
| `sourceType` | string | - | `web`, `manual`, `discord`, `import` |
| `page` | number | 1 | ページ番号 |
| `perPage` | number | 20 | 1ページあたりの件数（最大100） |

**レスポンス例:**

```json
{
  "items": [
    {
      "id": "cm...",
      "kind": "image",
      "title": "ブログ写真",
      "description": "",
      "status": "inbox",
      "trustLevel": "unverified",
      "canonicalDate": null,
      "originalFilename": "photo.jpg",
      "mimeType": "image/jpeg",
      "fileSize": 204800,
      "sha256": "abcdef...",
      "sourceType": "web",
      "storageProvider": "gdrive",
      "storageKey": "1ABC...",
      "storageUrl": "https://drive.google.com/...",
      "thumbnailUrl": "/api/drive-image/1ABC...",
      "createdAt": "2026-03-24T00:00:00.000Z",
      "updatedAt": "2026-03-24T00:00:00.000Z"
    }
  ],
  "total": 42
}
```

### POST /assets

アセットをメタデータから作成する。ファイルアップロードを伴う場合は `POST /upload` を使う。

リクエストボディは zod で検証される。**未知のキーは除去される**（拒否ではない）ので、`id` などを指定しても無視される。`classification` の空文字は未指定扱い、日付は `YYYY-MM-DD` と ISO 8601 の両方を受け付ける。型が合わないキーがあると `400 {"error":"<field>: <理由>"}` を返す。

作成に成功すると一覧・統計のキャッシュが無効化される。

**リクエストボディ (JSON):**

```json
{
  "kind": "text",
  "title": "ブログ記事タイトル",
  "description": "2024年1月15日のブログ",
  "sourceType": "web",
  "canonicalDate": "2024-01-15T00:00:00.000Z",
  "texts": [
    {
      "textType": "body",
      "content": "ブログ本文のテキスト...",
      "language": "ja"
    }
  ],
  "entities": [
    {
      "entityId": "cm_entity_id",
      "roleLabel": "author"
    }
  ],
  "sourceRecords": [
    {
      "sourceKind": "url",
      "title": "ブログタイトル",
      "url": "https://example.com/blog/123",
      "publisher": "Ameba",
      "publishedAt": "2024-01-15T00:00:00.000Z"
    }
  ]
}
```

**必須フィールド:**

- `kind`: `image` | `video` | `audio` | `text` | `document` | `other`

**省略可能なフィールド:**

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `title` | string | タイトル |
| `description` | string | 説明 |
| `status` | string | デフォルト `inbox` |
| `trustLevel` | string | デフォルト `unverified` |
| `sourceType` | string | デフォルト `manual` |
| `canonicalDate` | string (ISO 8601) | 元コンテンツの日付 |
| `storageProvider` | string | `gdrive`, `discord_url`, `external_url`, `local_none` |
| `storageUrl` | string | ファイルのURL |
| `thumbnailUrl` | string | サムネイルURL |
| `texts` | array | テキストデータ（本文、OCR等） |
| `entities` | array | 紐付けるエンティティ |
| `sourceRecords` | array | ソース情報 |

**texts の各要素:**

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|-----|------|
| `textType` | string | Yes | `title`, `body`, `description`, `message_body`, `ocr`, `transcript`, `note`, `extracted` |
| `content` | string | Yes | テキスト内容 |
| `language` | string | No | 言語コード (例: `ja`) |

**sourceRecords の各要素:**

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|-----|------|
| `sourceKind` | string | Yes | `url`, `discord_message`, `drive_file`, `manual`, `other` |
| `title` | string | No | ソースのタイトル |
| `url` | string | No | ソースURL |
| `publisher` | string | No | 配信元 |
| `publishedAt` | string | No | 公開日時 (ISO 8601) |
| `metadata` | object | No | 任意の追加情報 |

**レスポンス (201):**

作成されたアセット（リレーション含む）が返る。

### GET /assets/:id

アセットの詳細を取得する。texts, entities, sourceRecords, annotations, collectionItems のリレーションが含まれる。

**レスポンス例:**

```json
{
  "id": "cm...",
  "kind": "image",
  "title": "ブログ写真",
  "status": "inbox",
  "texts": [
    {
      "id": "cm...",
      "textType": "body",
      "content": "本文テキスト",
      "normalizedContent": "本文テキスト",
      "language": "ja"
    }
  ],
  "entities": [
    {
      "id": "cm...",
      "entityId": "cm...",
      "roleLabel": "featured",
      "entity": {
        "id": "cm...",
        "type": "person",
        "canonicalName": "坂井新奈",
        "aliases": []
      }
    }
  ],
  "sourceRecords": [...],
  "annotations": [...],
  "collectionItems": [...]
}
```

**エラー:**

```json
{ "error": "Not found" }  // 404
```

### PATCH /assets/:id

アセットのフィールドを部分更新する。指定したフィールドのみ更新される。

**リクエストボディ (JSON):**

```json
{
  "title": "更新後のタイトル",
  "status": "organized",
  "trustLevel": "high",
  "canonicalDate": "2026-03-23T19:34:00+09:00",
  "sourceType": "web",
  "entities": [
    {"entityId": "cm_xxx", "roleLabel": "author"},
    {"entityId": "cm_yyy"}
  ],
  "sourceRecords": [
    {
      "sourceKind": "url",
      "url": "https://example.com/blog/123",
      "title": "ブログタイトル",
      "publisher": "公式ブログ",
      "publishedAt": "2026-03-23T19:34:00+09:00"
    }
  ]
}
```

更新可能なフィールドは `POST /assets` のトップレベルフィールドと同じ。加えて `entities` と `sourceRecords` も指定可能。

**entities の挙動:**
- 渡された entityId が既にアセットに紐付いていれば `roleLabel` を更新する
- 紐付いていなければ新規追加する
- 渡さなかった既存の紐付けは削除されない（追加・更新のみ）

**sourceRecords の挙動:**
- 渡されたレコードはすべて新規追加される
- 既存の sourceRecords は削除されない

**レスポンス:** 更新後のアセット（リレーション含む）が返る。

---

## Search

### GET /assets/search

アセットとテキストを横断する全文検索。タイトル、説明、本文、エンティティ名を対象に、PGroonga の N-gram 索引で部分一致検索する。

全角/半角と大文字小文字は `NormalizerNFKC130` が正規化するため、「日向坂46」は「日向坂４６」にも、「！」は「!」にもヒットする。

**クエリパラメータ:**

| パラメータ | 型 | デフォルト | 説明 |
|-----------|-----|----------|------|
| `q` | string | **必須** | 検索クエリ |
| `target` | string | `all` | `all`, `assets`, `texts` |
| `kind` | string | - | アセット種別フィルタ |
| `status` | string | - | ステータスフィルタ |
| `trustLevel` | string | - | 信頼度フィルタ |
| `sourceType` | string | - | ソース種別フィルタ |
| `entityId` | string | - | 特定エンティティに紐づくもののみ |
| `dateFrom` | string (ISO 8601) | - | canonicalDate の開始日 |
| `dateTo` | string (ISO 8601) | - | canonicalDate の終了日 |
| `page` | number | 1 | ページ番号 |
| `perPage` | number | 20 | 件数（最大100） |

**レスポンス例:**

```json
{
  "items": [
    {
      "type": "asset",
      "assetId": "cm...",
      "assetTitle": "ブログ記事",
      "assetKind": "text",
      "assetStatus": "organized",
      "thumbnailUrl": null,
      "storageUrl": null,
      "snippet": "...検索語を含む前後のテキスト...",
      "matchField": "title",
      "score": 0.85,
      "createdAt": "2026-03-24T00:00:00.000Z"
    }
  ],
  "total": 5,
  "page": 1,
  "perPage": 20
}
```

---

## Entities

エンティティは人物、場所、タグなどの分類用オブジェクト。アセットに紐付けて使う。

### GET /entities

聖地エンティティ（`type: "place"`）は、紐づく `Place` の `classification` がキーのクリアランスを超える場合に除外される。`GET /entities/:id` も同条件で `404` を返す。

アセットに紐づくエンティティ（`GET /assets/:id` と `GET /assets?include=entities` の `entities`）も同条件で除外される。

**クエリパラメータ:**

| パラメータ | 型 | デフォルト | 説明 |
|-----------|-----|----------|------|
| `q` | string | - | 名前で検索（指定時は検索モード） |
| `type` | string | - | `person`, `place`, `source`, `event`, `tag` |
| `page` | number | 1 | ページ番号（検索モード以外） |
| `perPage` | number | 20 | 件数（最大100、検索モード以外） |

**レスポンス例 (一覧モード):**

```json
{
  "items": [
    {
      "id": "cm...",
      "type": "person",
      "canonicalName": "坂井新奈",
      "normalizedName": "坂井新奈",
      "aliases": [],
      "description": ""
    }
  ],
  "total": 10
}
```

**レスポンス例 (検索モード: `?q=坂井`):**

```json
{
  "items": [...]
}
```

### POST /entities

`type: "place"` は受け付けない（`400`）。聖地は `Place` と対で作る必要があるため `POST /places` を使う。

エンティティを作成する。同じ `type` + `canonicalName` が既に存在する場合は、既存のものがそのまま返る（upsert）。

**リクエストボディ (JSON):**

```json
{
  "type": "tag",
  "canonicalName": "ブログ"
}
```

**必須フィールド:** `type`, `canonicalName`

---

## Places

聖地（ロケ地・訪問先）。`Entity`（`type: "place"`）と対で管理され、`classification` によるクリアランス制御を受ける。公開サイト（sekai-nina-site）の聖地マップはビルド時に `GET /places` を読む。

### GET /places

クリアランス内の聖地をすべて返す（ページングなし、名前順）。

```json
[
  {
    "id": "cm...",
    "entityId": "cm...",
    "name": "SHE WOLF DINER",
    "description": "2025年12月4日に下田衣珠季とハンバーガーを食べた",
    "latitude": 35.6638,
    "longitude": 139.7003,
    "googleMapsUrl": "https://maps.app.goo.gl/...",
    "address": "東京都渋谷区...",
    "kind": "food",
    "area": "東京",
    "classification": "internal",
    "assetCount": 3,
    "createdAt": "...",
    "updatedAt": "..."
  }
]
```

`kind` は聖地の種類で、公開サイトの地図でピンのアイコンと絞り込みに使う。`food`（グルメ）/ `leisure`（レジャー）/ `scenery`（寺社・公園・景色）/ `venue`（会場・放送局）/ `shop`（店・施設）/ `null`（未設定。サイト側が名前・説明から推定する）。

`area` は聖地マップのエリア名（`東京` / `横浜・川崎` / `名古屋` など、人が付ける自由文字列）。公開サイトの絞り込みと遠景でのまとまりに使う。`null` はサイト側で「その他」扱い。既存のエリア名と同じ表記を使うこと（画面の入力欄は既存の名前を候補に出す）。

### POST /places

**必須フィールド:** `name`, `latitude`, `longitude`。任意: `googleMapsUrl`, `address`, `description`, `aliases`, `kind`, `area`, `classification`（既定 `internal`）。`kind` に上記以外の値を渡すと `400`。

### PATCH /places/:id

渡したフィールドだけ更新する。`kind` / `area` は `null` で未設定に戻せる（`area` は空文字も未設定扱い）。`classification` は引き上げのみ（前述）。

---

## Upload

### POST /upload

ファイルをアップロードしてアセットを作成する。Google Driveが設定されていればDriveに保存、なければローカルストレージに保存する。SHA256による重複チェックあり。

**リクエスト:** `multipart/form-data`

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|-----|------|
| `file` | File | Yes | アップロードするファイル |
| `title` | string | No | タイトル（省略時はファイル名） |
| `kind` | string | No | アセット種別（省略時はMIMEタイプから自動判定） |

**レスポンス (201):**

```json
{
  "id": "cm...",
  "duplicate": false
}
```

**重複時のレスポンス (200):**

```json
{
  "duplicate": true,
  "existingId": "cm...",
  "message": "Duplicate file: ブログ写真"
}
```

**curl例:**

```bash
curl -X POST http://localhost:3000/api/v1/upload \
  -H "Authorization: Bearer ak_your_key_here" \
  -F "file=@photo.jpg" \
  -F "title=ブログ写真"
```

---

## ファイル取得

アセットに紐づく画像やファイルは、アセットの `storageUrl` / `thumbnailUrl` フィールドに格納されたパスから取得する。

- Google Drive保存の場合: `/api/drive-image/<fileId>` （認証不要、キャッシュあり）
- ローカル保存の場合: `/api/files/<filename>` （認証不要）

画像のURLを組み立てるには:

```
GET /assets/:id → response.thumbnailUrl または response.storageUrl を取得
GET <そのパス> → 画像バイナリ
```

### 動画のサムネイル

**`/api/drive-image/<fileId>` を動画のサムネイルとして使ってはいけない。** このエンドポイントは Drive のファイル実体をそのまま返すため、動画アセットでは `video/mp4` が返る（`storageKey` は mp4 本体の fileId）。`<img>` では表示できず、かつ mp4 全体が毎回転送される。ダウンロード用途（`?download=1`）でのみ使う。

同様に `storageUrl` も Drive の閲覧ページ（HTML）の URL なので `<img>` には使えない。

動画のサムネイルは R2 上の実体（`thumbnailUrl`）のみが正となる。元画像には Drive が自動生成したサムネイル（`thumbnailLink`, 実測 640x360 程度）を使い、`pnpm cli:thumbnails --kind=video` で生成・登録する。まだ生成されていない動画は `thumbnailUrl` が `null` になるので、呼び出し側でプレースホルダを出すこと。

---

## 収集カバレッジ (Coverage) — v2（アイテム単位チェック）

観点 (Lens) × データソース (DataSource) の2軸。v2 ではチェックの最小単位を **アイテム**（ソースごとの投稿/ドキュメント単位: ブログ記事1本・トーク1日分・番組回1つ）にした。アイテムはテーブル実体化せず、`DataSource.itemRule` に従って `SourceRecord`/`Asset` から導出する（導出ビュー）。セルの表示値（済/総・「〜◯日まで反映済み」= `continuousUntil`）は `LensItemCheck` からの**導出値**。v1 の日付カーソル `collectedUntil` は廃止。詳細は `docs/coverage-design.md` を参照。

Lens / DataSource / Coverage / LensItemCheck はいずれも `classification` を持ち RLS が有効（clearance ベース）。導出クエリも clearance トランザクション経由なので Asset/SourceRecord の RLS が効く。`public` は「公開サイトの鮮度表示に出すか」を表す別の関心事。`Coverage` セルは v2 で **not_applicable マーク・メモ専用**に格下げ（追跡値は持たない）。

**itemRule**（`DataSource`）: `blog_url`（publisher が一致する SourceRecord の distinct url = 記事1本）/ `talk_date`（publisher が一致する Asset の canonicalDate 日単位 distinct）/ `source_url`（pattern が一致する distinct url = 番組回・動画単位）/ `manual`（導出なし）。`publisherPattern` / `titlePattern` は SourceRecord への SQL LIKE（null=不問）。いずれも `|` 区切りで複数パターンを書ける（いずれかに一致で OR。番組の切り分け・雑誌の複数誌対応。空要素は無視）。

### GET /lenses

観点の一覧（`sortOrder` 昇順）。`active=false` も含む。

```json
[
  {
    "id": "cl...", "key": "food", "name": "食べたもの",
    "description": "食べた・飲んだものの記録",
    "sortOrder": 50, "active": true, "public": true,
    "classification": "internal",
    "createdAt": "...", "updatedAt": "..."
  }
]
```

### POST /lenses

**ボディ:** `key`（必須・作成後変更不可・`^[a-z][a-z0-9_]*$`）, `name`（必須）, `description`, `sortOrder`, `public`, `classification`。

### PATCH /lenses/:id

`name` / `description` / `sortOrder` / `active` / `public` / `classification` を更新。`key` は変更不可（無視）。DELETE は無く、`active=false` で無効化する。

### GET /datasources

データソース一覧。フィールドは Lens に加えて `kind`（`blog` `talk` `tv` `youtube` `sns` `radio` `magazine` `live_event` `other`）。

### POST /datasources

**ボディ:** `key`（必須・不変）, `name`（必須）, `kind`（必須）, `description`, `sortOrder`, `public`, `classification`。

### PATCH /datasources/:id

`name` / `kind` / `description` / `sortOrder` / `active` / `public` / `classification` / `itemRule` / `publisherPattern` / `titlePattern` を更新。`key` は不変。

### GET /coverage

マトリクス全体（`lenses` / `dataSources` / `cells`）を返す。`?public=1` を付けると public かつ active な行・列のみに絞り、各セルの `note`（内部メモ）を除去する。`dataSources` には `itemRule` / `publisherPattern` / `titlePattern` / `totalItems`（導出アイテム総数）を含む。`cells` は全 lens×source の組み合わせ分（導出値入り）。

```json
{
  "lenses": [ { "id": "...", "key": "food", "name": "食べたもの", "sortOrder": 50, "active": true, "public": true, "classification": "internal" } ],
  "dataSources": [ { "id": "...", "key": "blog", "name": "公式ブログ", "kind": "blog", "sortOrder": 10, "active": true, "public": true, "classification": "internal", "itemRule": "blog_url", "publisherPattern": "日向坂46公式ブログ", "titlePattern": null, "totalItems": 3421 } ],
  "cells": [
    {
      "lensId": "...", "dataSourceId": "...",
      "lensKey": "food", "dataSourceKey": "blog",
      "status": "tracked", "note": null,
      "totalItems": 3421, "checkedItems": 120,
      "continuousUntil": "2026-06-25", "lastCheckedAt": "2026-07-11T..."
    }
  ]
}
```

セル導出値: `totalItems`（ソース共通の導出アイテム総数）/ `checkedItems`（当該観点でチェック済みの件数）/ `continuousUntil`（最古の未チェックの直前アイテムの日付。全チェックなら最新日、先頭から未チェックなら null）/ `lastCheckedAt`。`status=not_applicable` は対象外マーク（Coverage 行がある場合のみ。無ければ `tracked` 扱い）。

### PUT /coverage

セル注記を upsert する（`lensKey` + `dataSourceKey`）。v2 では日付カーソルを廃止し、`status`（`tracked` / `not_applicable`）と `note` のみ。

**ボディ:** `lensKey`（必須）, `dataSourceKey`（必須）, `status`（既定 `tracked`）, `note`, `classification`。監査は AuditLog `coverage.update`。

### GET /coverage/items

ソースのアイテム一覧（トリアージ・エンリッチ込み）。**クエリ:** `source`（必須・DataSource.key）, `lens`（省略時は全観点の `checkedLensKeys` 付き）, `checked`（`0`/`1`。`lens` 指定時のみ有効）, `relevant`（`1`=坂井新奈に**関連あり**〈言及 ∪ 本人著〉のみ / `0`=関連なしのみ。url 系ソースのみ有効・talk/manual では無視。旧名 `mentions` もエイリアスとして受付）, `order`（`asc`〈既定〉/`desc`）, `page`（既定 1）, `pageSize`（既定 100・最大 500）。`total` はフィルタ後の件数（ページング前）。

返却する**ページ分のアイテム**には以下がエンリッチされる（ソース全体ではなくページ分のみ・N+1 なしのバッチクエリ）:

- `mentions`（boolean）— 坂井新奈への言及。判定 = (a) 所属アセットに坂井新奈への `AssetEntity` リンク **または** (b) 所属アセットの `AssetText` 本文が canonicalName/aliases に一致。talk は全件本人=`true`。キー集合はソース全体で導出し数分キャッシュする。
- `authored`（boolean）— 坂井新奈が著者（所属アセットに `AssetEntity roleLabel='author'` リンク）。本人ブログには本人への言及が無いことがあるため、関連判定は 言及 ∪ 本人著 の2軸（v2.4）。
- `authors`（string[]）— 所属アセットの著者エンティティ名（重複除去）。例 `["山下葉留花"]`（v2.4）。
- `excerpts`（string[]）— url 系は一致箇所の前後スニペット（最大3件・一致語を `<mark>` で囲む HTML 安全文字列）。talk は本文先頭プレビュー（最大2件・`messageBodyPreview`）。
- `dossiers`（`{id,title}[]`）— アイテム所属アセットを含むドシエ（重複除去・`/dossiers/[id]` 導線用）。
- `repAsset`（`{id,kind} | null`）— 代表アセット（text 優先・日付順先頭）。タイトルの `/assets/[id]` リンク先（v2.3）。
- `imageAssets`（`{id}[]`）＋ `imageAssetCount`（number）— サムネイル有りの画像アセット（先頭8件＋画像総数）。`GET /assets/[id]/thumbnail`（302 リダイレクト）でサムネイルストリップ・ライトボックスを組む（v2.3）。
- `assetCount`（number）— 所属アセット総数。

「アイテム所属アセット」= url 系は同一 `SourceRecord.url` のアセット群、talk はその JST 日のトークアセット群。`source.relevantApplicable` は関連フィルタが有効か（url 系のみ `true`）。

```json
{
  "source": { "key": "blog", "name": "公式ブログ", "itemRule": "blog_url", "totalItems": 3421, "relevantApplicable": true },
  "lensKey": null, "order": "asc", "page": 1, "pageSize": 100, "total": 274, "relevant": true,
  "items": [
    {
      "itemKey": "https://...", "itemDate": "2020-09-19", "itemTitle": "記事タイトル", "isUrl": true,
      "checkedLensKeys": ["food"], "mentions": true, "authored": false, "authors": ["山下葉留花"],
      "excerpts": ["…今日は<mark>にぃな</mark>とごはん…"],
      "dossiers": [{ "id": "...", "title": "2020-09-19 おでかけ" }],
      "repAsset": { "id": "...", "kind": "text" },
      "imageAssets": [{ "id": "..." }], "imageAssetCount": 3, "assetCount": 4
    }
  ]
}
```

`lens` 指定時は各アイテムに `checkedLensKeys` の代わりに `checked`（boolean）が付く。

### PUT /coverage/checks

アイテムチェックのトグル（冪等）。**ボディ:** `lensKey`, `dataSourceKey`, `itemKey`, `checked`（boolean・必須）, `note?`, `classification?`。`checked=true` は upsert（`itemDate`/`itemTitle` は導出値のスナップショットを保存。導出に無い `itemKey` は 400）、`checked=false` は削除。監査は AuditLog `coverage.check`。

### POST /coverage/checks/bulk

範囲一括チェック。**ボディ:** `dataSourceKey`, `lensKeys[]`, `untilDate?`（`YYYY-MM-DD`・省略時は**全期間**〈v2.3〉）, `onlyIrrelevant?`（boolean・既定 false）, `classification?`。`itemDate <= untilDate` の全導出アイテムを対象 lens すべてに `createMany skipDuplicates`。`onlyIrrelevant=true` のときは**関連なし = 言及なし かつ 本人著でない**アイテムだけに絞る（v2.4「関連なしをここまで✓」。本人ブログには本人への言及が無いことがあるため著者軸も除外条件に含めて誤爆を防ぐ。キー集合はソース全体で導出・数分キャッシュ。url 系のみ有効・talk は全件本人）。返り値 `{ created, targetItems, lensKeys }`。監査は AuditLog `coverage.bulk_check`。

### GET /coverage/summary

公開サイト用の要約（`note` なし）。public かつ active な Lens × DataSource で、導出アイテムのある（`total > 0`）かつ not_applicable でないセルのみ。`minContinuousUntil` はその観点で最も遅れているソースの `continuousUntil`（どれか1つでも先頭から未チェック=null なら null）。

```json
{
  "generatedAt": "2026-07-12T...",
  "lenses": [
    {
      "key": "food", "name": "食べたもの",
      "sources": [
        {"key": "blog", "name": "公式ブログ", "continuousUntil": "2026-06-25", "checked": 120, "total": 150},
        {"key": "talk", "name": "トーク", "continuousUntil": "2026-05-30", "checked": 80, "total": 200}
      ],
      "minContinuousUntil": "2026-05-30"
    }
  ]
}
```

---

## 記事 (Articles)

公開サイト（世界新奈、`sekai-nina/sekai-nina-public`）の記事。akashic の DB が編集バッファで、書き込みは `dirty` になり、`/articles/push`（画面。admin のみ）で GitHub にまとめて push されるまで公開サイトには出ない。

想定する使い方は **「未反映の紐づけ（pending）を見て、抜粋を本文に反映し、applied にする」**:

1. `GET /articles?hasPending=true` で対象の記事を探す
2. `GET /articles/:shortId` で本文と `sources`（`status: "pending"` の行の `excerpt` が根拠の抜粋）を読む
3. `POST /articles/:shortId/sources/:sourceId/apply` で先に脚注番号 `sourceNo` を採る（公開判断）
4. 返った `sourceNo` で本文に `^[n]` を書き、`PATCH /articles/:shortId` に `body` と（apply が返した）`updatedAt` を渡して保存する

3 → 4 の順なのは、途中で止まっても「本文から参照されていない出典」（quote 記事では普通の状態）になるだけで、本文に宛先の無い `^[n]` が残らないため。

書き込み系（PATCH / apply）は **`updatedAt` による楽観ロックが必須**。GET が返した `updatedAt`（ISO 8601）をそのまま渡し、その間に別の保存・取り込み・apply が入っていれば `409 {"reason": "conflict", "updatedAt": "<現在>"}` が返る（読み直して作り直す）。push は `updatedAt` を動かさないので、push を挟んでも通る。

エラー応答の `reason` は機械可読な区別用（409 が衝突以外にも使われる apply で見る）。`conflict` 以外の 409 は再試行しても解消しない。

### GET /articles

**クエリパラメータ:**

| パラメータ | 説明 |
|---|---|
| `q` | タイトル・本文の部分一致 |
| `type` | `attribute` / `event` / `quote` / `column` / `item` |
| `hasPending` | `true` で未反映の紐づけがある記事だけ |
| `dirty` | `true` で未 push の記事だけ |
| `includeDraft` | 既定 `true`。`false` で下書きを除く |
| `page` / `perPage` | ページング（`perPage` は最大 100、既定 20） |

**レスポンス:**

```json
{
  "items": [
    {
      "shortId": "ygoez7r",
      "path": "attribute/draft_呼ばれ方.md",
      "title": "呼ばれ方",
      "type": "attribute",
      "tags": ["呼び名"],
      "publishedAt": "2026-03-14",
      "articleUpdatedAt": "2026-03-14",
      "draft": true,
      "unlisted": false,
      "dirty": false,
      "editedAt": null,
      "updatedAt": "2026-09-15T16:11:34.995Z",
      "sourceCount": 3,
      "pendingCount": 1
    }
  ],
  "total": 1, "page": 1, "perPage": 20
}
```

`sourceCount` はキーの持ち主のクリアランスで見える行の数（`ArticleSource` は RLS 対象）。`pendingCount` と `hasPending` は **API から apply できる pending 行（`internal` 以下）だけ**を数える（下記）。

### GET /articles/:shortId

```json
{
  "shortId": "ygoez7r",
  "path": "attribute/draft_呼ばれ方.md",
  "slug": null,
  "title": "呼ばれ方",
  "type": "attribute",
  "tags": ["呼び名"],
  "body": "## 本人が提案した呼び名\n\n- 「にぃたん」^[1]\n…",
  "date": "2025-04-10",
  "dateDisplay": "2025年4月10日〜2025年4月28日",
  "dateMode": null,
  "publishedAt": "2026-03-14",
  "articleUpdatedAt": "2026-03-14",
  "draft": true, "unlisted": false, "ongoing": false,
  "frontmatterExtraKeys": [],
  "dirty": false, "editedAt": null, "lastPushedAt": null,
  "updatedAt": "2026-09-15T16:11:34.995Z",
  "sources": [
    {
      "id": "cmu2bckbt000cd597c70p1isv",
      "status": "applied",
      "sourceNo": 1,
      "label": "坂井新奈ブログ「一生一度の 坂井新奈」",
      "url": "https://www.hinatazaka46.com/s/official/diary/detail/59569",
      "date": "2025-04-10",
      "classification": "public",
      "excerpt": "", "excerptType": null, "excerptStart": null, "excerptEnd": null, "note": "",
      "sortOrder": 0,
      "originalRef": "cmn3m8pho000qmoww7achsc61",
      "asset": {"id": "cmn3m8pho000qmoww7achsc61", "title": "…", "kind": "text", "canonicalDate": "2025-04-10T00:00:00.000Z", "classification": "internal"}
    },
    {
      "id": "cmu34rssz0001d5a54vg9h6op",
      "status": "pending",
      "sourceNo": null,
      "label": "",
      "url": null, "date": null,
      "classification": "internal",
      "excerpt": "本文から選んだ抜粋…", "excerptType": "body", "excerptStart": 120, "excerptEnd": 180, "note": "",
      "sortOrder": 2,
      "originalRef": null,
      "asset": {"id": "cmu2uyds80001jv048dzpukm7", "title": "おいしいよ〜😋", "kind": "text", "canonicalDate": null, "classification": "internal"}
    }
  ]
}
```

- `status`: `applied` = 本文の `^[n]` から参照される出典（frontmatter に載る）/ `pending` = akashic 側で紐づけただけで未反映 / `unresolved` = frontmatter にあるが Asset に解決できていない
- 日付の frontmatter 列（`date` / `publishedAt` / `articleUpdatedAt` / `sources[].date`）は `YYYY-MM-DD`（編集 UI と同じく暦日に丸める）。PATCH の入力と同じ形
- `frontmatterExtraKeys` はモデル化していない frontmatter のキー名（`featured_quotes` 等）。API からは触れない（push 時にそのまま復元される）
- クリアランスを超える出典は返らない（RLS）。加えて **`classification` が `internal` より上の `pending` 行は API では返さない**（API からは apply できないので、抜粋だけ見せて本文に貼らせる経路を作らない。画面には出る）
- `sources[].asset` は Asset が削除済み（`assetId` が null）か、Asset の classification がキーのクリアランスを超えるとき `null`

### PATCH /articles/:shortId

編集 UI と同じ 12 項目を部分更新する。渡した項目だけ変わる。`updatedAt` は必須。

```json
{
  "updatedAt": "2026-09-15T16:11:34.995Z",
  "body": "## 本人が提案した呼び名\n\n- 「にぃたん」^[1]\n- 「にな」^[3]\n",
  "articleUpdatedAt": "2026-09-16"
}
```

| フィールド | 型 | 備考 |
|---|---|---|
| `title` | string | 空も可（下書き） |
| `type` | `attribute` / `event` / `quote` / `column` / `item` / null | |
| `tags` | string[] | 全置換。この並びで公開サイトに出る。trim と重複除去あり |
| `body` | string | frontmatter を除いた Markdown。`\r\n` は `\n` に、先頭の空行は落とす（UI と同じ正規化） |
| `date` / `publishedAt` / `articleUpdatedAt` | `YYYY-MM-DD` / `""` / null | 暦に無い日付は 400 |
| `dateDisplay` | string / null | |
| `dateMode` | `single` / `range` / null | |
| `draft` / `unlisted` / `ongoing` | boolean | |

- `null` で消せるのは `type` / 日付 3 列 / `dateDisplay` / `dateMode` だけ。`title` / `body` / `tags` / 真偽値に `null` は 400（`tags` を空にするなら `[]`）
- `body` の上限は 200,000 文字（編集 UI と同じ `BODY_MAX_LENGTH`）
- 未知のキーは無視する。`path` / `shortId` / `slug` / `frontmatterExtra` / 出典は変えられない
- **変わっていなければ書かない**（`changed` が空で返り、`dirty` / `editedAt` も立たない）
- 書いたら `dirty = true` / `editedAt = now` になり、次の push に載る

**レスポンス:**

```json
{"shortId": "ygoez7r", "changed": ["body", "articleUpdatedAt"], "updatedAt": "2026-09-15T20:35:45.692Z"}
```

| ステータス | 意味 |
|---|---|
| 400 | JSON / 型の誤り、`updatedAt` 欠落、更新項目なし、`dateMode` 不正、暦に無い日付・本文の長さ超過（`fieldErrors` 付き） |
| 404 | 記事が無い |
| 409 | `updatedAt` が現在と違う。`{"error": …, "reason": "conflict", "updatedAt": "<現在>"}` |

### POST /articles/:shortId/sources/:sourceId/apply

`pending` の紐づけを `applied` にし、脚注番号を採番して返す。**公開を決める操作**: `ArticleSource` の classification が `public` になり、次の push でこの出典の `label` / `ref`（Asset ID）が公開リポジトリの frontmatter に載る。

```json
{"updatedAt": "2026-09-15T16:11:34.995Z"}
```

- `sourceNo` は `max(既存の脚注番号 ∪ 本文の ^[n]) + 1`。`sortOrder` は既存の出典の末尾
- `label` が空なら Asset のタイトルで埋める。`url` / `date` は付けない
- `excerpt` / `note` は残る（public 行になるので akashic 内では誰でも読める = 抜粋ごと公開判断）
- Article に `dirty = true` / `editedAt = now` が立つ
- 403 の判定は **出典行の `classification`（紐づけ時のアセットの値）と Asset の現在の `classification` の両方**に掛ける。紐づけ後にアセットが confidential に上げられていれば反映できない

**レスポンス:**

```json
{"shortId": "ygoez7r", "sourceId": "cmu34rssz0001d5a54vg9h6op", "sourceNo": 3, "updatedAt": "2026-09-15T20:35:15.234Z"}
```

| ステータス | `reason` | 意味 |
|---|---|---|
| 400 | | `updatedAt` 欠落・不正 |
| 403 | `above_limit` | 出典（またはその Asset）の classification が `internal` より上（画面から人間が行う） |
| 404 | `not_found` | 記事か紐づけが無い / クリアランスが足りず見えない（Asset が見えない場合を含む）/ 別の記事の紐づけ |
| 409 | `not_pending` | 既に反映済みか取り込み由来の出典。再試行しない |
| 409 | `asset_missing` | 紐づけ先の Asset が削除済み。再試行しない |
| 409 | `conflict` | `updatedAt` が現在と違う。`updatedAt` に現在の値が付くので、それで再試行するか読み直す |

記事の新規作成 API は無い（path / shortId の採番規則が未定。別 Issue）。

---

## ミーグリ記事ワークフロー (MeetGreets)

ミーグリ 1 回分の記事を作る手順（素材のドシエ → X レポ → スケッチ → 記事）を akashic で完結させるための器（設計は #106）。1 回のミーグリにつき 1 行で、素材置き場の `Dossier`（1:1、作成時に自動生成）・X レポの `RepoCollection`・生成した `Article` を束ねる。Discord bot はここを叩いて「確認はこちら」のリンクを返す想定。

`MeetGreet` は保護テーブル（`classification`、既定 `internal`）。一覧・詳細は API キーの持ち主の clearance で見える行だけ。

### GET /meetgreets

日付降順の一覧。各行に進み具合（ドシエの件数 / keep 件数 / スケッチ有無 / 記事有無）が付く。

```json
{
  "items": [
    {
      "id": "…",
      "date": "2026-08-01",
      "format": "real",
      "single": "17thシングル「Kind of love」",
      "label": "京都",
      "classification": "internal",
      "dossier": {"id": "…", "title": "2026-08-01 京都リアミ", "itemCount": 18, "updatedAt": "…"},
      "repoCollection": {"id": "…", "name": "…", "lastFetchedAt": "…", "keep": 8, "total": 99},
      "article": null,
      "sketch": {"key": null, "url": null, "candidates": [], "extraPrompt": ""},
      "createdBy": {"id": "…", "name": "…"},
      "createdAt": "…",
      "updatedAt": "…"
    }
  ]
}
```

- `format` は `online` / `real`。記事のタイトル・地の文では「オンラインミーグリ / リアルミーグリ」（略称は使わない）
- `date` は JST の暦日（`YYYY-MM-DD`）。ISO 日時ではない
- `article` は記事生成（#109）後に埋まる。`sketch` はスケッチ生成（#108）後に埋まる

### POST /meetgreets

起点。1 回の呼び出しで次を行う:

1. ドシエを `"<date> <label><オンミ|リアミ>"`（例: `2026-08-01 京都リアミ`）で作成。`viewMode` / `editMode` は `clearance`（キーの持ち主以外も編集できるように）
2. X レポ収集（`RepoCollection`）を既定のハッシュタグ条件（`src/lib/meetgreet/config.ts` の `reportTagGroups`。オンライン = `(#坂井新奈 #ミーグリ) OR #にぃぐり`、リアルはさらに `#リアルミーグリ` / `#リアルレポ` / `#坂井新奈` 単独）、期間 = 当日〜翌日 で作成し、**収集を 1 回走らせる**
3. 素材候補（下記）を返す

```json
{
  "date": "2026-08-01",
  "format": "real",
  "single": "17thシングル「Kind of love」",
  "label": "京都",
  "classification": "internal"
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `date` | `YYYY-MM-DD` | ✓ | 開催日（JST） |
| `format` | `"online"` / `"real"` | ✓ | 形式 |
| `single` | string (≤200) | | シングル名。記事 frontmatter の `meetgreet.single` に出る |
| `label` | string (≤50) | | 回の呼び分け（通常 / 初回限定盤 / 京都 など）。ドシエ・収集の名前に付くだけ |
| `classification` | enum | | 既定 `internal`。キーの持ち主の clearance より上は 403 |

未知のフィールドは 400（strict）。

**レスポンス（201）:** 一覧の 1 行と同じ形に `fetch` と `candidates` が付く。

```json
{
  "id": "…",
  "…": "…",
  "fetch": {"ok": true, "result": {"fetched": 99, "added": 99, "mediaSaved": 120}},
  "candidates": [
    {
      "key": "blog:https://www.hinatazaka46.com/s/official/diary/detail/70435",
      "kind": "blog",
      "title": "坂井新奈ブログ「待ち合わせ🎐」",
      "url": "https://www.hinatazaka46.com/s/official/diary/detail/70435",
      "matched": true,
      "assets": [
        {"id": "…", "kind": "text", "title": "坂井新奈ブログ「待ち合わせ🎐」", "canonicalDate": "…", "thumbnailUrl": null, "inDossier": false, "suggested": true},
        {"id": "…", "kind": "image", "title": "坂井新奈ブログ「待ち合わせ🎐」 (1/11)", "canonicalDate": "…", "thumbnailUrl": "https://…", "inDossier": false, "suggested": true}
      ]
    },
    {"key": "talk", "kind": "talk", "title": "トーク", "url": null, "matched": false, "assets": ["…"]}
  ]
}
```

- **X の収集失敗は 201 のまま `fetch.ok = false`**（`error` に理由）。recent search は直近 7 日しか遡れないので、古い日付では必ず失敗する。あとから `POST /meetgreets/:id/reports` で再収集できる
- `candidates` は当日〜10 日後の、坂井新奈が付いたアセットを **出典で分類**したもの（`kind`: `blog` = 本人ブログ / `staff` = ひなたぼっこ日記 / `talk` = トーク / `other`）。ブログは URL ごとに 1 グループ
- `suggested` が初期チェック（本文にミーグリの話があるブログ = `matched` の全アセット、当日〜翌日のトーク画像 / 動画、本文にミーグリの話があるトークのテキスト）。`inDossier` は既にドシエに入っている
- 抜粋（本人の感想）はここでは付かない。ドシエ側の範囲選択（#108 で LLM の提案が入る）

### GET /meetgreets/:id

一覧の 1 行 + `candidates`（`POST` と同じ形。`inDossier` は現在のドシエの状態を反映）。

### PATCH /meetgreets/:id

`single` / `label` / `extraSketchPrompt` を部分更新（渡した項目だけ変わる）。`date` / `format` は変えられない（変えたければ作り直す。ドシエ・収集は残る）。

### POST /meetgreets/:id/materials

```json
{"assetIds": ["…", "…"]}
```

指定したアセットをドシエに `asset_ref` で入れる（caption = アセットのタイトル）。**同じアセットは 2 回入らない**（既にある / キーの clearance で見えない / 存在しないものは `skipped` に数えて飛ばす）。

**レスポンス:** `{"added": 12, "skipped": 2, "dossierId": "…"}`

### POST /meetgreets/:id/reports

X レポを再収集する（作成時に失敗したとき、翌日以降の投稿を拾うとき）。ボディ無し。成功で `{"fetched": n, "added": n, "mediaSaved": n}`、X API の失敗は 502。keep / total は `GET /meetgreets/:id` の `repoCollection` で読む。判定（keep / reject）自体の API は無い（画面 `/repo/:id` で人が行う）。

---

## パイプライン監視 (Jobs)

bot や外部ワーカーの各ジョブが実行ごとに結果を報告し、akashic の `/status` が「報告が途絶えた」「失敗した」を検知する（設計は `docs/status-design.md`）。

### POST /jobs/:key/runs

1 サイクル分の実行結果を報告する。`key` は報告側が名乗る識別子（`^[a-z0-9][a-z0-9_.-]{0,63}$`。`bot.blog_watch` / `worker.stats` のように `<出所>.<ジョブ>`）。Job は**初回の報告で自動作成**される。

```json
{
  "status": "ok",
  "message": "",
  "count": 2,
  "durationMs": 1830,
  "intervalSec": 60,
  "name": "bot: ブログ監視"
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `status` | `"ok"` / `"error"` | ✓ | 例外で落ちた回は `error` |
| `message` | string (≤2000) | | 失敗理由の**要約**。ok でも補足があれば |
| `count` | integer ≥ 0 | | 処理した件数（登録した記事数など）。`0` は「無し」と同じ扱い |
| `durationMs` | integer ≥ 0 | | 実行時間 |
| `intervalSec` | integer ≥ 1 | | 実行間隔（秒）。**申告すると `/status` が「その 3 倍の時間、成功が無い」を途絶として検知する**（下限 15 分）。毎回送ってよい |
| `name` | string (≤100) | | 表示名。無ければ `key` |

未知のフィールドは 400（strict）。`key` が `^[a-z0-9][a-z0-9_.-]{0,63}$` に合わなければ 400。

- **正常で何も無かった回も `ok` で報告する**（それが生存の証拠）。`ok` で `count` が無い報告は、最新の履歴行（`JobRun`）から 1 時間以内なら行を増やさず最終成功時刻だけ更新する（= 静かな成功は 1 時間に 1 行）
- **`message` に本文や秘密を入れない。** `/status` はログイン済み全員に見え、要約は Discord にも流れる（要約は 200 字に切る）。例外の型と一言で十分。署名付き URL・トークン・処理対象のメッセージ本文は載せない
- 1 回の `error` では `/status` は error にならない。**1 周期（下限 15 分）成功が無い**ときに error になる（一時的な失敗で通知が往復しないため）
- 報告の失敗（akashic 側の障害）は報告側でログに残すだけにし、監視処理を止めない
- 監査ログには残さない
- どの write キーでもどの `key` にも報告できる（報告元の記録と制限は #102）

**レスポンス:**

```json
{
  "job": {"key": "bot.blog_watch", "name": "bot: ブログ監視", "intervalSec": 60, "lastRunAt": "…", "lastOkAt": "…", "lastStatus": "ok"},
  "recorded": true
}
```

`recorded` は履歴行を作ったかどうか（上のまとめ規則で作らなかったときは `false`）。

---

## 典型的な利用パターン

### Discord Botからブログ更新を自動登録

```python
import requests

API = "http://localhost:3000/api/v1"
HEADERS = {"Authorization": "Bearer ak_your_key"}

# 1. エンティティ（タグ）を確保
entity = requests.post(f"{API}/entities", json={
    "type": "tag",
    "canonicalName": "ブログ"
}, headers=HEADERS).json()

# 2. アセットを作成
asset = requests.post(f"{API}/assets", json={
    "kind": "text",
    "title": "2024/01/15 ブログ更新",
    "sourceType": "web",
    "canonicalDate": "2024-01-15T00:00:00.000Z",
    "texts": [{
        "textType": "body",
        "content": "ブログの本文テキスト..."
    }],
    "entities": [{
        "entityId": entity["id"]
    }],
    "sourceRecords": [{
        "sourceKind": "url",
        "url": "https://ameblo.jp/example/entry-123",
        "title": "ブログタイトル",
        "publisher": "Ameba"
    }]
}, headers=HEADERS).json()
```

### 画像付きブログをアップロード

```python
# 1. 画像をアップロード
with open("photo.jpg", "rb") as f:
    upload = requests.post(f"{API}/upload",
        headers=HEADERS,
        files={"file": ("photo.jpg", f, "image/jpeg")},
        data={"title": "ブログ写真"}
    ).json()

# 2. アップロードされたアセットにエンティティを紐付け
#    (PATCH でメタデータも更新可能)
requests.patch(f"{API}/assets/{upload['id']}", json={
    "status": "organized",
    "trustLevel": "high"
}, headers=HEADERS)
```

### AI エージェントが記事の未反映の紐づけを本文に反映する

```python
# 1. 未反映の紐づけがある記事を探す
articles = requests.get(f"{API}/articles", params={"hasPending": "true"}, headers=HEADERS).json()["items"]

# 2. 本文と pending の抜粋を読む
article = requests.get(f"{API}/articles/{articles[0]['shortId']}", headers=HEADERS).json()
pending = next(s for s in article["sources"] if s["status"] == "pending")

# 3. 先に脚注番号を採る (公開判断。updatedAt は 2 で読んだ値)
applied = requests.post(
    f"{API}/articles/{article['shortId']}/sources/{pending['id']}/apply",
    json={"updatedAt": article["updatedAt"]}, headers=HEADERS,
).json()   # {"sourceNo": 3, "updatedAt": "<新しい値>", ...}

# 4. 本文に ^[n] を書いて保存 (updatedAt は 3 が返した値)
body = article["body"] + f"\n- {pending['excerpt']}^[{applied['sourceNo']}]\n"
requests.patch(f"{API}/articles/{article['shortId']}", json={
    "updatedAt": applied["updatedAt"],
    "body": body,
    "articleUpdatedAt": "2026-09-16",
}, headers=HEADERS)
```

### 他システム（facebench等）からアセットを検索・取得

```python
# キーワード検索
results = requests.get(f"{API}/assets/search",
    params={"q": "坂井新奈", "kind": "image"},
    headers=HEADERS
).json()

# 画像URLを取得して利用
for item in results["items"]:
    if item["thumbnailUrl"]:
        image_url = f"http://localhost:3000{item['thumbnailUrl']}"
        # image_url から画像をダウンロード（認証不要）
```
