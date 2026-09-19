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
| GET | `/anniversaries` | read | 記念日（初めて〇〇した日）一覧と埋まった日数 |
| POST | `/anniversaries` | write | 記念日作成 |
| GET | `/anniversaries/:id` | read | 記念日詳細 |
| PATCH | `/anniversaries/:id` | write | 記念日の部分更新 |
| DELETE | `/anniversaries/:id` | write | 記念日削除 |
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
| POST | `/articles` | write | 記事の新規作成（`shortId` / `path` はサーバ採番。既定 `draft: true`） |
| GET | `/articles/:shortId` | read | 記事詳細（本文・frontmatter・出典） |
| PATCH | `/articles/:shortId` | write | 記事の部分更新（`updatedAt` 必須の楽観ロック） |
| POST | `/articles/:shortId/sources/:sourceId/apply` | write | 紐づけを反映済みにする（公開判断。internal 以下のみ） |
| POST | `/jobs/:key/runs` | write | ハートビート（bot / ワーカーのジョブが実行結果を報告する） |
| POST | `/usage` | write | LLM の利用量の自己申告（トークン数を送ると akashic が金額に換算する） |
| GET | `/meetgreets` | read | ミーグリ（記事ワークフロー）一覧と進み具合 |
| POST | `/meetgreets` | write | ミーグリ作成（ドシエと X レポ収集を自動作成し収集を 1 回実行、素材候補を返す） |
| GET | `/meetgreets/:id` | read | ミーグリ詳細 + 素材候補 |
| PATCH | `/meetgreets/:id` | write | シングル名・呼び分け・スケッチ追加指示の更新 |
| POST | `/meetgreets/:id/materials` | write | 素材候補のチェック結果をドシエに反映 |
| POST | `/meetgreets/:id/reports` | write | X レポの再収集 |
| POST | `/meetgreets/:id/sketch` | write | 服装スケッチの候補を生成（作り直しも） |
| POST | `/meetgreets/:id/sketch/select` | write | 候補の 1 枚を確定 |
| POST | `/meetgreets/:id/article` | write | 記事を生成（既存があれば増えた分だけ追記） |

---

### 機密レベル (`classification`) の変更制限

API キーからは **引き上げしかできない。** `PATCH /assets/:id` / `PATCH /places/:id` / `PATCH /anniversaries/:id` に現在より低い `classification` を渡すと `403 {"error":"Cannot lower classification (<現在> -> <指定>) via API key"}` を返す。

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

## 記念日 (Anniversaries)

坂井新奈が「初めて〇〇した日」。公開サイト（sekai-nina-site）のトップ「今日は〇〇の日」と記念日ページの正で、366 日すべてを埋めるのが目標。サイトはビルド時に `GET /anniversaries` を読む（聖地と同じ方式）。`classification` によるクリアランス制御を受ける（既定 `internal` = 公開サイトに出る。`confidential` 以上は出ない）。

画面では、ブログ / トークのアセットページの「記念日に登録」から日付（`canonicalDate` の JST）と出典アセットが埋まった状態で登録する。

### GET /anniversaries

クリアランス内の記念日をすべて返す（ページングなし、**月日順**。同じ月日は年の古い順）。

```json
{
  "items": [
    {
      "id": "cm...",
      "date": "2025-04-10",
      "monthDay": "04-10",
      "title": "初ブログの日",
      "description": "『一生一度の 坂井新奈』というタイトルでブログを初めて投稿した",
      "source": { "url": "https://www.hinatazaka46.com/s/official/diary/detail/59569", "label": "坂井新奈ブログ「一生一度の坂井新奈」", "publisher": "日向坂46公式ブログ" },
      "asset": { "id": "cm...", "title": "坂井新奈ブログ「一生一度の坂井新奈」", "kind": "text", "date": "2025-04-10" },
      "article": { "id": "cm...", "shortId": "DhLvmF8", "path": "quote/ひなあい初登場時の自己紹介.md", "slug": null, "title": "ひなあい初登場時の自己紹介" },
      "classification": "internal",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "filledDays": 10,
  "totalDays": 366
}
```

- `date` は JST の暦日文字列。`monthDay` が毎年の記念日、年は「〇年前」の計算に使う
- `source` は手入力の `sourceUrl` があればそれ、無ければ出典アセットの `SourceRecord`（url / publisher）から平らにしたもの。どちらも無ければ `null`
- `filledDays` は同じ月日を 1 と数えた埋まった日数（`items.length` とは違う）

### POST /anniversaries

**必須フィールド:** `date`（暦に実在する `YYYY-MM-DD`）, `title`（100 文字以内）。任意: `description`（1000 文字以内）, `assetId`（自分のクリアランスで見えるアセット）, `sourceUrl`（http(s)）, `articleId`（`Article.id`）, `classification`（既定 `internal`）。

### PATCH /anniversaries/:id

渡したフィールドだけ更新する。`assetId` / `sourceUrl` / `articleId` は `null` で外せる。`classification` は引き上げのみ（前述）。

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

記事を起こすところから任せるときは、先に `POST /articles` で作る（`draft: true` で作られるので push されても公開サイトには出ない。出典の紐づけと draft の解除は人が画面で行う。紐づけ API は #110）。

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

### POST /articles

記事を新規作成する。`title` と `type` が必須、残りは PATCH と同じ項目を省略可。`shortId` と `path` はサーバが採番する（クライアントは指定できない）。

```json
{
  "title": "Yes, me now?",
  "type": "quote",
  "tags": ["歌詞"],
  "body": "## 概要\n\n…",
  "date": "2026-09-01"
}
```

| フィールド | 型 | 備考 |
|---|---|---|
| `title` | string | **必須。空不可**（PATCH と違う）。`path` のファイル名になる |
| `type` | `attribute` / `event` / `quote` / `column` / `item` | **必須**。`path` のディレクトリになる |
| `tags` / `body` / `date` / `dateDisplay` / `dateMode` / `publishedAt` / `articleUpdatedAt` / `draft` / `unlisted` / `ongoing` | PATCH と同じ | 省略時は下の既定値。正規化・検証も PATCH と同じ |

**省略時の既定値:**

| フィールド | 既定 | 理由 |
|---|---|---|
| `draft` | `true` | 公開サイトの記事ページに出さない。**push そのものは止めないので、本文は公開リポジトリ（`sekai-nina-public`、public）に載る**。公開サイトに出すのは人が編集 UI か PATCH で `draft: false` にしたとき（作成時に `draft: false` を明示することもできる） |
| `publishedAt` / `articleUpdatedAt` | 今日（JST） | Obsidian のテンプレートと同じ。呼び出し側が UTC で「今日」を計算すると JST 0〜9 時に 1 日ずれるので、省略してサーバに任せるのが安全 |
| `date` | null | event 以外はほぼ空。出来事の日は明示する |
| `tags` / `body` | `[]` / `""` | |
| `dateDisplay` / `dateMode` | null | |
| `unlisted` / `ongoing` | `false` | |

明示した `null` / `""` は空のまま（今日で埋めない）。

**採番規則:**

- `shortId`: 7 桁 base62 のランダム（公開サイトの `scripts/assign-slugs.ts` と同じ。衝突なら再採番）
- `path`: `<type>/<ファイル名>.md`。ファイル名はタイトルを **NFC に正規化 → 制御文字を除去 → ファイル名に使えない `/ \ : * ? " < > |` を全角 `／ ＼ ： ＊ ？ ” ＜ ＞ ｜` に置換 → 前後の空白を trim** したもの（上の例は `quote/Yes, me now？.md`）。**タイトルは NFC 正規化だけで、全角置換はしない**（`title` は `Yes, me now?` のまま）
- 409 は**導出後の path** で判定し、大文字小文字は区別しない（macOS の checkout が `abc.md` と `ABC.md` を同時に持てないため）。`Yes, me now?` と `Yes, me now？` は同じ `path` になるので衝突する。全角置換は多対一なので、`path_exists` の応答には既存記事の `title` も入る
- 判定は DB だけでなく**公開リポジトリの tree に対しても行う**（`ARTICLES_GITHUB_TOKEN` がある環境のみ。取り込み前のファイルと同じ path で作ると、次の取り込みが中断し、その記事も永久に push できなくなる）
- タイトルは NFC に正規化し、制御文字を取り除いてから保存する（`\u0000` は Postgres の `text` に入らず、他の C0 文字は公開リポジトリの `title:` に不可視文字として残る）
- 作成後にタイトルを変えても `path` は追随しない（PATCH と同じ）。`slug` は null、モデル外の frontmatter は空

**レスポンス:** `201` で `GET /articles/:shortId` と同じ形（`sources` は空）。`updatedAt` は続けて PATCH するときの楽観ロックに使う。

| ステータス | `reason` | 意味 |
|---|---|---|
| 400 | | JSON / 型の誤り、`title` / `type` の欠落・空（zod の検証。`reason` なし） |
| 400 | `invalid` | 暦に無い日付・本文の長さ超過・`dateMode` 不正（`fieldErrors` 付き） |
| 400 | `invalid_path` | `path` にできないタイトル（`.` / `_` 始まり、`readme` を含む、ファイル名が 255 バイト超）。理由は `fieldErrors.title` |
| 409 | `path_exists` | 同じ `path` の記事が既にある（大文字小文字は区別しない）。`{"reason": "path_exists", "path": "…", "shortId": "<既存>", "title": "<既存のタイトル>"}`。再試行せず、同じ題材ならその `shortId` を PATCH し、別の記事ならタイトルを変える |
| 409 | `path_exists_upstream` | 公開リポジトリに同じ `path` のファイルがあるが、akashic に取り込まれていない。**そのまま作ると取り込みが止まる**ので作らせない。別のタイトルにするか、先に `pnpm cli:import-articles` を実行してもらう |

書いたら `dirty = true` / `editedAt = now` になり、次の push で新規ファイルとして公開リポジトリに載る。`path` は必ず `<type>/` 始まりなので、`quiz/` 配下（実データ 3 本。`type` は `attribute`）はこの API からは作れない。出典（`ArticleSource`）は作成時には付かない。

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

記事の削除 API は無い（削除は画面から人間が行う）。出典を pending で紐づける API は #110。

---

## ミーグリ記事ワークフロー (MeetGreets)

ミーグリ 1 回分の記事を作る手順（素材のドシエ → X レポ → スケッチ → 記事）を akashic で完結させるための器（設計は #106）。1 回のミーグリにつき 1 行で、素材置き場の `Dossier`（1:1、作成時に自動生成）・X レポの `RepoCollection`・生成した `Article` を束ねる。Discord bot はここを叩いて「確認はこちら」のリンクを返す想定。

`MeetGreet` は保護テーブル（`classification`、既定 `internal`）。一覧・詳細は API キーの持ち主の clearance で見える行だけ。

「本人の感想」の抜粋提案（ドシエのブログ本文から該当箇所を LLM に選ばせる）は**画面だけ**の機能で API は無い。公開サイトに載る引用文なので、人が範囲を確認してからドシエに入れる前提のため。

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
      "venue": "幕張メッセ",
      "classification": "internal",
      "dossier": {"id": "…", "title": "2026-08-01 京都リアミ", "itemCount": 18, "updatedAt": "…"},
      "dossierId": "…",
      "repoCollection": {"id": "…", "name": "…", "lastFetchedAt": "…", "keep": 8, "total": 99},
      "article": null,
      "sketch": {"key": null, "url": null, "candidates": [{"key": "meetgreet/…/sketch/0.png", "url": "https://…"}], "extraPrompt": ""},
      "createdBy": {"id": "…", "name": "…"},
      "createdAt": "…",
      "updatedAt": "…"
    }
  ]
}
```

- `format` は `online` / `real`。記事のタイトル・地の文では「オンラインミーグリ / リアルミーグリ」（略称は使わない）
- `date` は JST の暦日（`YYYY-MM-DD`）。ISO 日時ではない
- `article` は記事を作る / 紐づけると埋まる。`sketch` はスケッチ生成後に埋まる
- **`dossier` は `null` になりうる。** ドシエは別テーブルで所有者・`viewMode` による RLS が別に効くので、所有者があとから `private` に戻したり機密を上げると、他の人には見えなくなる。ID は常に `dossierId` で返すので、`dossier` が `null` なら「ドシエが見えない」を表示する
- `repoCollection` も `null` になりうる（収集を消した場合。`classification` は MeetGreet と同じ値で作られるので、通常は同じ人に見える）

### POST /meetgreets

起点。1 回の呼び出しで次を行う:

1. ドシエを `"<date> <label><オンミ|リアミ>"`（例: `2026-08-01 京都リアミ`）で作成。`viewMode` / `editMode` は `clearance`（キーの持ち主以外も編集できるように）
2. X レポ収集（`RepoCollection`）を既定のハッシュタグ条件（`src/lib/meetgreet/config.ts` の `reportTagGroups`。オンライン = `(#坂井新奈 #ミーグリ) OR #にぃぐり`、リアルはさらに `#リアルミーグリ` / `#リアルレポ` / `#坂井新奈` 単独）、期間 = 当日〜翌日 で作成する（**収集は走らせない**）
3. 素材候補（下記）を返す

`dossierId` / `repoCollectionId` を渡すと、新しく作らず**既にあるものを使う**。`/meetgreets` を作る前から手で用意していたドシエ・収集を拾い直すときに使う（画面の「過去のドシエを取り込む」が内部でこれを呼ぶ）。

作成は **1 トランザクション**。途中で失敗しても名前だけ同じドシエが残ることはない。

**X の収集はここでは走らない**（#118）。収集するかどうかは別の判断なので、`POST /meetgreets/:id/reports` で明示的に実行する。作成自体は数秒で返る。

**冪等ではない**ので、応答が無いときは再送せず `GET /meetgreets` で作成済みか確かめる。

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
| `classification` | enum | | 既定 `internal`。キーの持ち主の clearance より上は 403。**MeetGreet・ドシエ・X レポ収集の 3 つに同じ値が付く**（既存のものに紐づけるときは、そちらの値は変えない） |
| `dossierId` | string | | 既にあるドシエを使う。未指定なら新しく作る |
| `repoCollectionId` | string | | 既にある X レポ収集を使う。未指定なら新しく作る |

未知のフィールドは 400（strict）。`date` は**暦に実在する日付**でなければ 400（`2026-02-30` のような日付は `Date.parse` が 3/2 に正規化して通してしまうので、往復で検証している）。

エラーの切り分け: 入力が不正なら 400、clearance が足りなければ 403、それ以外（DB エラー等）は 500。**400 は「直さない限り何度送っても失敗する」を意味する**ので、再送してよいのは入力を直したときだけ。

既に別のミーグリに使われているドシエ・収集を指定すると 400。

**レスポンス（201）:** 一覧の 1 行と同じ形に `candidates` が付く。

```json
{
  "id": "…",
  "…": "…",
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

- `candidates` は当日〜10 日後の、坂井新奈が付いたアセットを **出典で分類**したもの（`kind`: `blog` = 本人ブログ / `staff` = ひなたぼっこ日記 / `talk` = トーク / `other`）。ブログは URL ごとに 1 グループ
- `suggested` が初期チェック（本文にミーグリの話があるブログ = `matched` の全アセット、当日〜翌日のトーク画像 / 動画、本文にミーグリの話があるトークのテキスト）。`inDossier` は既にドシエに入っている
- 抜粋（本人の感想）はここでは付かない。ドシエ側の範囲選択（#108 で LLM の提案が入る）

### GET /meetgreets/:id

一覧の 1 行 + `candidates`（`POST` と同じ形。`inDossier` は現在のドシエの状態を反映）。

### PATCH /meetgreets/:id

`single` / `label` / `venue` / `extraSketchPrompt` を部分更新（渡した項目だけ変わる）。`venue` は会場の正式名称（「幕張メッセ」）で、**リアルミーグリの記事タイトルに出る**（空文字で消す）。`label` は短い呼び分け（「通常」「京都」）でドシエ名・収集名に使うだけなので、記事には出ない。`date` / `format` は変えられない（変えたければ作り直す。ドシエ・収集は残る）。更新項目が 1 つも無い（`{}`）なら 400。

**レスポンス:** 更新後の行（`GET /meetgreets` の 1 行と同じ形。`candidates` は付かない）。

なお `label` を変えても、**作成済みのドシエ名・収集名は変わらない**（それぞれの画面で変更する）。

### POST /meetgreets/:id/materials

```json
{"assetIds": ["…", "…"]}
```

指定したアセットをドシエに `asset_ref` で入れる（caption = アセットのタイトル、`sortOrder` は末尾に連番）。**同じアセットは 2 回入らない**（既にドシエにある / キーの clearance で見えない / 存在しないものは `skipped` に数えて飛ばす）。1 回に 500 件まで。

書き込みはドシエの編集権限が要る（`editMode: clearance` + role `admin` / `member` + clearance が足りること。作成時のドシエはこの条件を満たす）。権限が無ければ 403、ドシエが消えていれば 404。

**レスポンス:** `{"added": 12, "skipped": 2, "dossierId": "…"}`

### POST /meetgreets/:id/reports

X レポを収集する（作成時には走らないので、**最初の 1 回もこれで実行する**）。ボディ無し。成功で `{"fetched": n, "added": n, "mediaSaved": n}`。収集が紐づいていなければ 409、X API 側の失敗（トークン未設定・レート制限・7 日より前の日付）は 502。**数十秒かかる**（X API のページングと、取得した画像を 1 枚ずつ縮小して R2 に上げるため。実測で最大 80 秒程度）。bot から呼ぶときは先に deferred ack すること。

keep / total は `GET /meetgreets/:id` の `repoCollection` で読む。判定（keep / reject）自体の API は無い（画面 `/repo/:id` で人が行う）。

---

### POST /meetgreets/:id/sketch

その日の服装スケッチ（記事のサムネ / OGP 画像）の候補を生成する。ドシエに入っている写真を参照に、シリーズの画風をそろえるための**基準スケッチ**を添えて OpenAI の画像編集 API（`gpt-image-1`）に投げる。

```json
{"assetIds": ["…", "…"], "revisionOf": "meetgreet/…/sketch/1789…-0.png", "revisionNote": "袖のふくらみをもっと大きく"}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `assetIds` | string[] | ✓ | 参照にする画像。**ドシエに入っている `internal` 以下の画像に限る**（1〜15 枚。`revisionOf` を渡すときは 14 枚まで） |
| `revisionOf` | string | | 作り直しの元にする候補の key（`sketch.candidates[].key`）。渡すとその画像も参照に足す |
| `revisionNote` | string (≤2000) | | 作り直しの指示 |

**レスポンス:** `{"candidates": [{"key": "…", "url": "https://…"}, …]}`（既定 2 枚）。`sketch.candidates` には追記され、過去の候補は消えない。確定するまで `sketchKey` は変わらない。

- **1 回あたり 1 分前後かかる**（実測: 参照 2 枚 + 基準スケッチで 59 秒）。`POST /meetgreets` と同じく bot は deferred ack してから呼ぶ
- 回ごとの追加指示（どの髪型を中央にするか等）は `PATCH /meetgreets/:id` の `extraSketchPrompt` に入れておく。生成のたびにプロンプトの末尾に足される
- 入力は **16 枚まで**という API の制限があり、最後の 1 枚を基準スケッチに使うので写真は 15 枚まで。**作り直しのときは直す候補でもう 1 枚使うので 14 枚まで**（超えると 400）
- **`confidential` 以上のアセットは参照にできない。** 画像の中身を外部 API に送る操作なので、`internal` 以下に限っている（[docs/security-dev.md](./security-dev.md)）
- 画像は Drive に原本があればそれを、無ければ R2 の 640px サムネイルを使う
- 生成は `1536x1024` で行い、**左右に白を足して 1.91:1（1956x1024）にする**。`gpt-image-1` が出せるのは 1024x1024 / 1536x1024 / 1024x1536 の 3 つだけで 1.91:1 を直接出せないため。上下を切ると頭や補助スケッチが欠けるので、描かれたものが減らない白埋めにしている
- `revisionNote` は `revisionOf` と一緒にしか渡せない（単独なら 400）
- 入力が不正なら 400、生成の失敗（OpenAI / R2）は 502、こちらの設定漏れ（キー未設定等）は 500

### POST /meetgreets/:id/sketch/select

```json
{"key": "meetgreet/…/sketch/1789…-0.png"}
```

候補の 1 枚を確定して `sketchKey` にする（記事のサムネになる）。`sketch.candidates` に無い key は 400。**レスポンス:** 更新後の行。

---

### POST /meetgreets/:id/article

ドシエと採用した X レポから記事を生成する。**既存の記事が紐づいていれば「増えた分だけ」追記**し、無ければ新規作成する。

```json
{"dryRun": true}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `dryRun` | boolean | | `true` なら書き込まず、適用後の本文と増える行だけ返す |
| `expectedDigest` | string | | `dryRun` が返した `digest`。渡すと、組み立て直した結果が変わっていたら 409（見せた内容と別のものを保存しない） |

**レスポンス（`dryRun: true`）:**

```json
{
  "mode": "append",
  "title": "2026年8月1日 リアルミーグリ（京都）",
  "body": "…適用後の本文…",
  "digest": "3f2a…",
  "addedLines": [42],
  "newSources": [{"sourceNo": 6, "label": "坂井新奈トーク 2026.8.3 12:00", "url": null, "date": "2026-08-03", "assetId": "…"}],
  "droppedByClearance": 0,
  "empty": false,
  "shortId": "0izz31T"
}
```

**レスポンス（保存）:** `{"mode": "append", "shortId": "…", "added": 1, "sources": 1}`

- `mode` は `create` / `append`。**フル再生成は無い**（手で入れた `![rep]` や文面の調整を消すため。必要なら記事の編集画面から）
- **追記は「純粋な追記」でなければ中止する**（既存行が 1 行でも消える形になったら 409）。脚注番号も既存のまま据え置き、新しい出典だけ末尾に採番する
- **本文に載るのは `internal` 以下のアセットだけ。** `Article` は非保護テーブルで、本文は push でそのまま公開リポジトリに載るため。落とした件数は `droppedByClearance` で返す（[docs/security-dev.md](./security-dev.md)）
- 出典は `applyArticleSource` と同じ経路で作られるので、公開に落とせる機密レベルの制限もそのまま効く
- 生成しただけでは公開されない。`dirty` な記事になり、`/articles/push`（画面）で公開リポジトリに出る
- **TikTok は短縮 URL を解決できたものだけ載せる。** 解決に失敗したものは落とす（短縮のままでは埋め込みにならず、video ID が無いので次の追記で重複するため）
- TikTok の短縮 URL を解決するため外部に出る。数秒〜十数秒かかることがある

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

### POST /usage

LLM の利用量を報告する。akashic が単価表で USD に換算し、**日次 × プロバイダ × モデル × 機能**に積む（設計は `docs/costs-design.md`）。

```json
{
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "feature": "bot.discovery",
  "inputTokens": 741,
  "cachedInputTokens": 0,
  "outputTokens": 47,
  "requests": 1
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `provider` | `"openai"` / `"anthropic"` / `"google"` | ✓ | |
| `model` | string (≤100) | ✓ | API に渡したモデル名そのまま。日付サフィックスや `models/` 接頭辞が付いていてもよい |
| `feature` | string | ✓ | 呼び出し元。`^[a-z0-9][a-z0-9_.:-]{0,63}$`。`<出所>.<機能>` で揃える（`bot.discovery` / `worker.fitan_site`） |
| `inputTokens` | integer ≥ 0 | | キャッシュ読み出しを**含まない**入力 |
| `cachedInputTokens` | integer ≥ 0 | | キャッシュから読んだ入力（安い単価で換算する） |
| `outputTokens` | integer ≥ 0 | | |
| `requests` | integer ≥ 0 | | 省略時は 1。まとめて報告するときだけ指定する |
| `date` | `YYYY-MM-DD` | | **JST の暦日**。省略時は今日。過去分をまとめて入れるときだけ指定 |

未知のフィールドは 400（strict）。

- **同じ日・同じモデル・同じ機能への報告は足し込まれる**（1 回ごとに送ってよい）
- **単価表（`src/lib/costs/pricing.ts`）に無いモデルは金額を出さず、トークンだけ記録する。** 応答の `unpriced` が `true` になり、`/costs` に「価格未登録」として出る（黙って 0 円にはしない）
- 報告の失敗で呼び出し側の本処理を止めないこと（集計より本処理が優先）
- 監査ログには残さない

**レスポンス:**

```json
{"date": "2026-09-19", "costUsd": 0.000139, "unpriced": false}
```

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

### AI エージェントが記事を起こす

```python
# draft: true / publishedAt・articleUpdatedAt = 今日 (JST) で作られる。shortId / path はサーバ採番
created = requests.post(f"{API}/articles", json={
    "title": "好きな時間帯",
    "type": "attribute",
    "tags": ["生活"],
    "body": "## 概要\n\n…",
}, headers=HEADERS)
if created.status_code == 409:            # 同じ path の記事が既にある → そちらを PATCH する
    short_id = created.json()["shortId"]
    article = requests.get(f"{API}/articles/{short_id}", headers=HEADERS).json()
else:
    created.raise_for_status()            # 400 は入力の誤り (fieldErrors を見る)
    article = created.json()              # GET /articles/:shortId と同じ形

# 続けて直すときは (読み直さずに) 返った updatedAt を渡す
requests.patch(f"{API}/articles/{article['shortId']}", json={
    "updatedAt": article["updatedAt"],
    "body": article["body"] + "\n追記\n",
}, headers=HEADERS)
# 出典の紐づけと draft の解除は人が画面で行う (紐づけ API は #110)
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
