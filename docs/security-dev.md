# セキュリティ開発者ガイド

コードを書く人向け。新しい機能を追加するときのルール。

## 鉄則

**保護テーブル（Asset, AssetText 等）にアクセスするときは、必ず `withClearance` を使う。**

```typescript
import { withClearance } from "@/lib/db";

// OK: withClearance で囲んでいる
const assets = await withClearance(clearance, async (tx) => {
  return tx.asset.findMany({ where: { status: "inbox" } });
});

// NG: 素の prisma で保護テーブルにアクセス
// → RLS により 0 行が返る（データが見えない）
const assets = await prisma.asset.findMany({ where: { status: "inbox" } });
```

## `withClearance` の仕組み

```typescript
export async function withClearance<T>(
  clearance: string,        // ユーザーのクリアランスレベル
  fn: (tx) => Promise<T>    // トランザクション内で実行する関数
): Promise<T>
```

内部的には：
1. トランザクションを開始
2. `SET app.clearance = '...'` でクリアランスをセット
3. `fn(tx)` を実行（この中の全クエリに RLS が適用される）
4. トランザクションを終了

## clearance の取得方法

```typescript
// ページ（セッション認証）
const session = await auth();
const clearance = session!.user.clearance;

// API ルート（API キー認証）
const auth = await requireApiAuth(request, "read");
const clearance = auth.clearance;
```

## いつ `withClearance` を使い、いつ使わないか

| 状況 | 使うもの |
|------|---------|
| ユーザーにデータを返す | `withClearance(clearance, ...)` |
| ユーザーがデータを作成/更新/削除する | `withClearance(clearance, ...)` |
| CLI ツール・Bot（内部処理） | `prismaInternal` |
| 統計集計（全体カウント等） | `prismaInternal` |
| User / Entity / Collection の操作 | `prisma`（保護対象外テーブル） |

## 保護テーブル一覧

以下のテーブルに RLS が設定されています。素の `prisma` でアクセスすると 0 行が返ります。

- `Asset`, `AssetText`, `AssetEntity`, `AssetRelation`
- `SourceRecord`, `Annotation`, `CollectionItem`, `Testimonial`

## 新しいテーブルを追加するとき

アセットに関連するテーブル（`assetId` を持つ）を追加する場合：

1. マイグレーションで RLS を有効化：
   ```sql
   ALTER TABLE "NewTable" ENABLE ROW LEVEL SECURITY;
   ALTER TABLE "NewTable" FORCE ROW LEVEL SECURITY;
   ```

2. `app_runtime` 用のポリシーを追加：
   ```sql
   CREATE POLICY newtable_select ON "NewTable" FOR SELECT TO app_runtime USING (
     EXISTS (SELECT 1 FROM "Asset" WHERE id = "NewTable"."assetId"
       AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
   );
   -- INSERT, UPDATE, DELETE も同様
   ```

3. Supabase SQL Editor で `app_runtime` に権限付与：
   ```sql
   GRANT SELECT, INSERT, UPDATE, DELETE ON "NewTable" TO app_runtime;
   ```

## `classificationFilter` と `assertClearance`

`src/lib/classification.ts` にあるユーティリティ。RLS 導入前のアプリ層ガード。

- `classificationFilter(clearance)` — Prisma WHERE 句に分類フィルタを追加
- `assertClearance(userClearance, assetClassification)` — クリアランスチェック（不足なら throw）

RLS があるので読み取り時は不要ですが、**書き込み時のクリアランスチェック**（例：ユーザーが自分のクリアランスより高い機密レベルでアセットを作成しようとした場合）には引き続き使います。

## DB 接続の構成

```
prisma          → DATABASE_URL → app_runtime（RLS 適用）
prismaInternal  → DIRECT_URL   → postgres（RLS バイパス）
```

`prisma` を使う限り、RLS が自動で効きます。ただし `withClearance` でクリアランスを設定しないと、何も見えません（フェイルセーフ）。
