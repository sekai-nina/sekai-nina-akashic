# Akashic MCP サーバー

AI アシスタント（ふぃたん等）が Akashic を操作するための [Model Context Protocol](https://modelcontextprotocol.io/) サーバー。

Next.js 本体に同居する 1 本のエンドポイントで、REST API v1 と同じ API キーで認証する。クライアント側にインストールするものは無い。

```
POST /api/mcp     # Streamable HTTP
```

## クライアント設定

```json
{
  "mcpServers": {
    "akashic": {
      "type": "http",
      "url": "https://<host>/api/mcp",
      "headers": {
        "Authorization": "Bearer ak_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

API キーの発行は REST API と共通。

```bash
pnpm cli:keygen <user-email> <key-name>
```

## 認証と権限

- 認証は `Authorization: Bearer ak_<64hex>`。キーが無効・未指定なら **401**、キーは有効だが `read` を持たないなら **403**（`{"error":"Missing permission: read"}`）
- **キーの `permissions` によって見えるツールが変わる。** `write` を持たないキーには書き込みツールが `tools/list` に出ない（呼んでも `Tool ... not found`）
- クリアランスは**キーの持ち主ユーザーのもの**が使われる。読み取りは RLS が、書き込みは `assertClearance` が上位機密の作成を止める
- **既存レコードの機密レベルは引き上げしかできない。** `akashic_update_asset` / `akashic_update_place` に現在より低い `classification` を渡すとエラーになる。`assertClearance` は「自分のクリアランスより上を付ける」操作しか止めず、引き下げ (例: `restricted` → `public`) は素通りするため。MCP は LLM がツールを呼ぶ経路なので、プロンプトインジェクション 1 回で機密アセットを公開扱いに落とせないようアプリ層で塞いでいる。引き下げは画面から人間が行う
- 専用のクリアランスを与えたい場合は、AI 用のユーザーを作ってそのユーザーでキーを発行する

## ツール一覧

| ツール | 権限 | 用途 |
|---|---|---|
| `akashic_search` | read | アセットの全文検索（本文・タイトル・OCR・書き起こし） |
| `akashic_get_asset` | read | アセット 1 件の詳細（本文・エンティティ・出典） |
| `akashic_list_entities` | read | 人物・聖地・タグ・番組の検索 |
| `akashic_list_places` | read | 聖地一覧（緯度経度・住所つき） |
| `akashic_create_asset` | write | アセットの下書き登録（`status` は必ず `inbox`） |
| `akashic_update_asset` | write | メタデータ・ステータス・本文の更新 |
| `akashic_create_place` | write | 聖地登録（Google Maps URL / 緯度経度） |
| `akashic_update_place` | write | 聖地更新 |

削除系のツールは意図的に用意していない。削除は画面から人間が行う。

### 検索語の区切り

`akashic_search` の `q` は **空白では分割されない。**「坂井新奈 渋谷」は 1 つの語として `ILIKE '%坂井新奈 渋谷%'` になる。複数語を OR で引くときは **`/` 区切り**（「坂井新奈/渋谷」）。URL を渡すと URL 一致で検索する。これは `src/lib/search/index.ts` の `splitQueryTerms` の仕様。

### `akashic_list_entities` のページング

聖地エンティティ（`type: "place"`）は、紐づく `Place` の `classification` がキーのクリアランスを超える場合に除外される。`akashic_get_asset` が返す `entities` も同条件で除外される。`Entity` テーブルの RLS ポリシーは素通しなので、アプリ層で絞っている。

`q` を省略したときだけ `page` / `perPage` によるページングが効き、`total`（総件数）を返す。`q` を指定すると上位 `perPage` 件までの打ち切りになり、総件数は分からないので `{ returned, perPage, hasMore, items }` を返す。

### 返却形式

domain 層の戻り値をそのまま返すのではなく、AI が使うフィールドだけに間引いた JSON を返す。`id` は後続ツールの入力になるので必ず含まれる。`url` は `AUTH_URL` を基点にした画面へのリンクで、Discord にそのまま貼れる。

```json
{
  "total": 42,
  "page": 1,
  "perPage": 20,
  "items": [
    {
      "id": "cm1abc",
      "kind": "image",
      "status": "organized",
      "title": "ブログ写真",
      "date": "2026-03-24",
      "matchedIn": "body",
      "snippets": ["…今日は渋谷に…"],
      "persons": ["坂井新奈"],
      "tags": ["ブログ"],
      "url": "https://…/assets/cm1abc"
    }
  ]
}
```

アセット詳細の本文は先頭 4000 文字で切り詰める（末尾に全文字数を付記）。

日付は用途で基準が違う。`date`（`canonicalDate`）は「YYYY-MM-DD の UTC 00:00」格納規約なので UTC 基準で切り出し、`sources[].publishedAt` と `createdAt` / `updatedAt` は実時刻なので **JST** に直してから返す。実時刻を UTC で切ると JST 0〜9 時のデータが前日にずれる。

## 設計上の決めごと

### 作成したアセットは必ず `inbox` に入る

`akashic_create_asset` に `status` パラメータは無い。AI が作ったものは必ず人間の仕分け（`/inbox`）を通る。仕分けを進めるときは `akashic_update_asset` で明示的に `status` を変える。

### エンティティは名前で受け、既存にしか紐づけない

AI は `entityId` を知らないので `entityNames` に名前を渡す。正規化名（`normalizeText`）で一致した既存エンティティだけが紐づき、**一致しなかった名前は作らずに返す。**

```json
{
  "id": "cm1abc",
  "linkedEntities": [{ "id": "cmmtp8…", "name": "坂井新奈", "type": "person" }],
  "unresolvedEntities": ["渋谷スクランブル"],
  "hint": "一致するエンティティが無い名前があります: … akashic_list_entities で類似名を探して正式名称で指定し直すか、本当に新規のタグでよければ createMissingEntities: true を付けて再実行してください。"
}
```

`createMissingEntities: true` を明示したときだけ、未解決の名前を **`tag` として**新規作成する。`person` / `place` は自動生成しない（メンバーは `cli:sync-members`、聖地は `akashic_create_place` の管轄）。

同名エンティティが複数の種別に存在する場合は紐づけず、`ambiguousEntities` に候補を返す。

この設計は `findOrCreateEntity` が `canonicalName` の完全一致 upsert であることに由来する。「坂井 新奈」のような表記ゆれをそのまま通すと重複エンティティが増える（`cli:merge-entities` が要るようになる）。

### `sourceType` の決まり方

明示指定 > Discord 情報があれば `discord` > `manual`。

`web` を指定するとブログ扱いになり、`OPENAI_API_KEY` があれば口コミ抽出がバックグラウンドで走る。ブログのアーカイブ以外では指定しない。

### 入力は zod で検証する

MCP のツール引数はもともと zod で検証されるが、REST の `POST /api/v1/assets` は `body as CreateAssetData` の無検証キャストだった。リクエスト JSON の任意のキーが `createAsset` の `...assetFields` 経由で `asset.create` に流れるため、クライアントが `id` を指定できてしまう。

`src/lib/domain/asset-intake.ts` の `AssetIntakeSchema` を REST と共有し、**未知のキーは黙って除去**（拒否ではない）、既知のキーは型を検証する。既存クライアントを壊さないため `classification: ""` は未指定扱いとし、日付は `YYYY-MM-DD` と ISO 8601 の両方を受ける。

### 本文の更新は非破壊

`akashic_update_asset` が公開するのは `upsertTexts` のみで、`textType` 単位の置き換えになる。指定しない `textType`（`body` 等）は消えない。全置換する `texts` は MCP には出していない。

### 聖地登録は Google Maps URL を受ける

`googleMapsUrl` を渡すと短縮 URL（`maps.app.goo.gl` 等）を展開して緯度経度と地点名を取り出す。`latitude` / `longitude` を直接渡してもよい。両方あれば明示指定が優先される。

解決ロジックは `src/lib/places/resolve-google-maps-url.ts` にあり、`GET /api/v1/places/resolve-url` と共有している。

**受け付けるのは `http(s)` かつ Google Maps のホストのみ**（`google.<tld>` 系と `maps.app.goo.gl` / `goo.gl` / `g.co`）。短縮 URL は展開後のホストも再検証する。これは戻り値が `Place.googleMapsUrl` に保存され、聖地詳細画面で `<a href>` として描画されるため — MCP 経由だと URL の出所が LLM（= 外部入力）になるので、`javascript:` / `data:` スキームや任意ホストを通すとフィッシング・XSS の入口になる。リダイレクトを追うのも短縮 URL のホストに限定している（任意の URL を fetch させない）。

`akashic_update_place` で `googleMapsUrl` の解決に失敗した場合は**エラーを返して何も更新しない。** 素通しすると URL だけ新しい場所に差し替わり、緯度経度が古いまま残るため。

同名の聖地が既にある場合は作成せず、既存の `existingPlaceId` を返す。

### 監査ログ

書き込みツールは domain 層が出す `asset.create` などとは別に、`mcp.<tool>` を 1 本追記する。

```
action:     "mcp.create_asset"
targetType: "Asset"
targetId:   "cm1abc"
actorId:    <キーの持ち主>
metadata:   { apiKeyId, tool, args }
```

`actorId` だけでは人間の操作と区別できないため。読み取りツールは件数が多いので記録しない。

## 動作確認

```bash
pnpm cli:mcp-check <baseUrl> <apiKey> [--write] [--q <検索語>]

# ローカル
pnpm cli:mcp-check http://localhost:3000 ak_xxxx

# 本番（読み取りのみ）
pnpm cli:mcp-check https://<host> ak_xxxx --q 坂井新奈
```

`initialize` → `tools/list` → 読み取りツール一周を実行する。`--write` を付けたときだけ書き込みツールも叩く（テスト用アセットが `inbox` に残るので、確認後に画面から削除する）。

curl で直接叩く場合:

```bash
curl -X POST http://localhost:3000/api/mcp \
  -H "Authorization: Bearer ak_xxxx" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 実装

| ファイル | 役割 |
|---|---|
| `src/app/api/mcp/route.ts` | エンドポイント。`requireApiAuth` で認証し `authInfo` に載せて渡す |
| `src/lib/mcp/server.ts` | `createMcpHandler` の組み立て。リクエストごとに `McpServer` を作る |
| `src/lib/mcp/tools.ts` | ツール定義。権限で登録するツールを出し分ける |
| `src/lib/mcp/format.ts` | 返却用の射影・URL 組み立て |
| `src/lib/mcp/entity-resolution.ts` | エンティティ名の解決 |
| `src/lib/mcp/audit.ts` | `mcp.<tool>` の監査ログ |
| `src/lib/domain/asset-intake.ts` | REST / MCP 共通のアセット作成経路 |
| `src/cli/mcp-check.ts` | スモークテスト |

SDK は [`@modelcontextprotocol/server`](https://www.npmjs.com/package/@modelcontextprotocol/server) v2。ハンドラは web 標準の `fetch` 形なので App Router にそのまま挿さる。ステートレス（セッション・Redis なし）。

Vercel 製の `mcp-handler` は使っていない。あれは factory に `McpRequestContext`（`authInfo` / `requestInfo`）を渡さないので、キーの権限に応じた `tools/list` の出し分けができない。

`src/middleware.ts` の MFA ガードは `/api/mcp` を `/api/v1/` と同様に素通しする。
