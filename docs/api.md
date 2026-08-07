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

---

### 機密レベル (`classification`) の変更制限

API キーからは **引き上げしかできない。** `PATCH /assets/:id` と `PATCH /places/:id` に現在より低い `classification` を渡すと `403 {"error":"Cannot lower classification (<現在> -> <指定>) via API key"}` を返す。

`assertClearance` は「自分のクリアランスより上を付ける」操作しか止めず、引き下げ (例: `restricted` → `public`) は素通りするため。API キーは MCP（LLM がツールを呼ぶ経路）と共通なので、アプリ層で塞いでいる。引き下げは画面から人間が行う。

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
