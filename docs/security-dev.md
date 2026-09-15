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
| User / Entity / Article の操作 | `prisma`（保護対象外テーブル） |
| Entity を一覧・検索でユーザーに返す | `listEntities` / `searchEntities` / `getEntityById`（`entityClearanceWhere` を通す） |

## 保護テーブル一覧

以下のテーブルに RLS が設定されています。素の `prisma` でアクセスすると 0 行が返ります。

- `Asset`, `AssetText`, `AssetEntity`, `AssetRelation`
- `SourceRecord`, `Annotation`, `Testimonial`
- `Dossier`, `DossierItem`, `DossierPlaceCandidate`, `Place`
- `RepoCollection`, `RepoTweet`, `RepoTweetMedia`
- `Lens`, `DataSource`, `Coverage`, `LensItemCheck`
- `ArticleSource`（`Article` 自体は公開記事のミラーなので非保護）

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

## 公開リポジトリへ書き出すもの（記事の push）

記事（`Article`）は公開リポジトリ sekai-nina/sekai-nina-public のミラーで、push 時に DB のカラムから frontmatter を丸ごと生成し直します。`ArticleSource` は保護テーブルで、frontmatter 由来の行（`public`）と akashic 側で付けた紐づけ（元アセットの classification を継承）が混ざるため、**読んだものをそのまま書き出すと押した人の clearance で公開内容が変わります**。

不変条件は「**frontmatter に載る = `pending` 以外 かつ `public`**」。これを 2 層で守ります。

1. **読み出しは固定の最低クリアランス** — `renderArticleForPush` は操作者ではなく `PUSH_CLEARANCE`（`public`）で `withClearance` する。RLS が非 public の行を落とす
2. **組み立て側でも絞る** — `buildFrontmatter` は `status` / `classification` を必須にした `ArticleSourceRow` しか受け取らず、`isPublishableSource` で絞った上で、落とした行を `pending`（件数）と `blocked`（`applied` / `unresolved` なのに非 public）に分けて返す

`blocked` は本文が `^[n]` で参照しているのに脚注だけ消える矛盾状態なので、**1 件でもあれば push を拒否**します。`renderArticleForPush` はこの検出を `withClearance("restricted")` で脚注番号だけ引いて行い、`ok: false` のときは Markdown を組み立てません（`prismaInternal` で数えないのは、`DIRECT_URL` 未設定時に `DATABASE_URL` へ無言でフォールバックして常に 0 件 = fail-open になるため）。

したがって `pending` を `applied` に遷移させる処理は、classification を明示的に `public` に下げる「公開を決める」操作として実装してください。その際、`ArticleSource` の RLS は行単位なので **`excerpt` / `note`（機密アセットからの抜粋・内部メモ）も public クリアランスから見えるようになる**ことに注意。frontmatter には載りませんが akashic 内の可視範囲が変わるので、遷移時に抜粋を空にするか、見えてよい内容に限る運用にするかを決めてから実装すること。

DB から生成した Markdown と実ファイルの突き合わせは `pnpm cli:verify-article-push --dir <articles>` で行えます。

## DB 接続の構成

```
prisma          → DATABASE_URL → app_runtime（RLS 適用）
prismaInternal  → DIRECT_URL   → postgres（RLS バイパス）
```

`prisma` を使う限り、RLS が自動で効きます。ただし `withClearance` でクリアランスを設定しないと、何も見えません（フェイルセーフ）。
