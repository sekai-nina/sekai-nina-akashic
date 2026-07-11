# Akashic REST API v1

Akashicのデータを外部システムから操作するためのREST API。

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
| GET | `/coverage` | read | カバレッジ・マトリクス |
| PUT | `/coverage` | write | セル upsert |
| GET | `/coverage/summary` | read | 公開サイト用の要約 |

---

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

アセットとテキストを横断する全文検索。タイトル、説明、本文、エンティティ名を対象に、ILIKE + pg_trgm の類似度で検索する。

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

---

## 収集カバレッジ (Coverage)

観点 (Lens) × データソース (DataSource) ごとに「何日の分まで反映したか」(`collectedUntil`) を記録する。カーソルは日付1点 (`YYYY-MM-DD`) のみ。詳細は `docs/coverage-design.md` を参照。

Lens / DataSource / Coverage の3テーブルはいずれも `classification` を持ち RLS が有効（他テーブルと同じ clearance ベース）。`public` は「公開サイトの鮮度表示に出すか」を表す別の関心事。

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

`name` / `kind` / `description` / `sortOrder` / `active` / `public` / `classification` を更新。`key` は不変。

### GET /coverage

マトリクス全体（`lenses` / `dataSources` / `cells`）を返す。`?public=1` を付けると public かつ active な行・列のみに絞り、各セルの `note`（内部メモ）を除去する。

```json
{
  "lenses": [ { "id": "...", "key": "food", "name": "食べたもの", "sortOrder": 50, "active": true, "public": true, "classification": "internal" } ],
  "dataSources": [ { "id": "...", "key": "blog", "name": "公式ブログ", "kind": "blog", "sortOrder": 10, "active": true, "public": true, "classification": "internal" } ],
  "cells": [
    {
      "id": "...", "lensId": "...", "dataSourceId": "...",
      "lensKey": "food", "dataSourceKey": "blog",
      "status": "tracked", "collectedUntil": "2026-06-25",
      "note": "...", "updatedById": "...", "updatedAt": "..."
    }
  ]
}
```

セルの状態: `tracked`（`collectedUntil` まで収集済み） / `not_applicable`（対象外・`collectedUntil` は常に null）。マトリクスに現れないセル（行なし）は「未着手」を表す。

### PUT /coverage

セルを upsert する（`lensKey` + `dataSourceKey` で特定）。

**ボディ:** `lensKey`（必須）, `dataSourceKey`（必須）, `status`（`tracked` / `not_applicable`, 既定 `tracked`）, `collectedUntil`（`YYYY-MM-DD`）, `note`, `classification`。`status=not_applicable` のとき `collectedUntil` は強制的に null になる。監査は AuditLog `coverage.update` に記録。

### GET /coverage/summary

公開サイト用の要約（`note` なし）。public かつ active な Lens × DataSource の tracked セルのみ。`minCollectedUntil` はその観点で最も遅れているソースの日付。`not_applicable` と未着手は含めない。

```json
{
  "generatedAt": "2026-07-12T...",
  "lenses": [
    {
      "key": "food", "name": "食べたもの",
      "sources": [
        {"key": "blog", "name": "公式ブログ", "collectedUntil": "2026-06-25"},
        {"key": "talk", "name": "トーク", "collectedUntil": "2026-05-30"}
      ],
      "minCollectedUntil": "2026-05-30"
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
