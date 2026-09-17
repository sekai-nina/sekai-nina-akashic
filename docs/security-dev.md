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
| User / Entity / Article / Job / JobRun / StatusCheckState の操作 | `prisma`（保護対象外テーブル） |
| Entity を一覧・検索でユーザーに返す | `listEntities` / `searchEntities` / `getEntityById`（`entityClearanceWhere` を通す） |

## 保護テーブル一覧

以下のテーブルに RLS が設定されています。素の `prisma` でアクセスすると 0 行が返ります。

- `Asset`, `AssetText`, `AssetEntity`, `AssetRelation`
- `SourceRecord`, `Annotation`, `Testimonial`
- `Dossier`, `DossierItem`, `DossierPlaceCandidate`, `Place`
- `RepoCollection`, `RepoTweet`, `RepoTweetMedia`
- `Lens`, `DataSource`, `Coverage`, `LensItemCheck`
- `ArticleSource`（`Article` 自体は公開記事のミラーなので非保護）
- `MeetGreet`（ミーグリ記事ワークフロー。ドシエを include する読みは所有者判定が要るので `withSession`）

`Job` / `JobRun` / `StatusCheckState`（パイプライン監視 `/status`）は件数・時刻・メッセージしか持たない運用情報なので非保護。評価 (`src/lib/status/checks.ts`) は cron がセッション外で走らせるため保護テーブルを `prismaInternal` で数えるが、結果はログイン済み全員に見えるので **`detail` に写す名前・タイトルは `internal` 以下の行に限る**（`STATUS_VISIBLE_CLEARANCE`。今日の発見の SQL は `classificationFilterSql("internal")`、鮮度チェックは public / internal の `DataSource` だけ）。confidential 以上は件数にも入れない。本文は出さない（リンク先は各ページの RLS で守られる）。

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

`blocked` は本文が `^[n]` で参照しているのに脚注だけ消える矛盾状態なので、**1 件でもあれば push を拒否**します。`renderArticlesForPush` はこの検出を `withClearance("restricted")` で脚注番号だけ引いて行い、`ok: false` のときは Markdown を組み立てません（`prismaInternal` で数えないのは、`DIRECT_URL` 未設定時に `DATABASE_URL` へ無言でフォールバックして常に 0 件 = fail-open になるため）。

RLS はここでは「public 行が返ってくる」方向にも頼っているので、restricted 側で記事ごとの `pending` 以外の総数も数え、**public で見えた行数 + `blocked` = 総数** でなければバッチ全体を止めます（`app.clearance` が効いていない等で行が落ちると、脚注を全部失った記事を 1 コミットで公開してしまう）。

したがって `pending` を `applied` に遷移させる処理は、classification を明示的に `public` に下げる「公開を決める」操作です → `applyArticleSource`（次節）。

DB から生成した Markdown と実ファイルの突き合わせは `pnpm cli:verify-article-push --dir <articles>` で行えます。

### 紐づけの反映（pending → applied、`applyArticleSource`）

`src/lib/domain/articles.ts` の `applyArticleSource` が唯一の経路。REST（`POST /api/v1/articles/:shortId/sources/:sourceId/apply`）/ MCP（`akashic_apply_article_source`）/ 画面（記事詳細の「反映済みにする」）がすべてこれを呼ぶ。

- **公開を決める操作。** `status = applied` と同時に `classification = public` にする。次の push でその行の `label` / `ref` が公開リポジトリの frontmatter に載る
- **API キー経路は `internal` 以下の出典しか反映できない**（`API_APPLY_MAX_CLASSIFICATION`、`src/lib/articles/apply.ts`）。`docs/api.md` / `docs/mcp.md` の「API キーからの引き下げは不可」の例外で、機械が公開を決めてよい範囲を internal までに限る。`confidential` / `restricted` は画面から人間が押す（画面経路は `maxClassification` を渡さない）。加えて全経路で `assertClearance` を通す（RLS で見えている行でも規約どおりアプリ層で止める）
- **ガードは出典行の `classification` と Asset の現在の `classification` の両方に掛ける。** 行の値は紐づけ時のスナップショットで、後から `updateAsset` でアセットを上げても伝播しない。Asset が RLS で見えない（関係が null なのに `assetId` はある）ときも `not_found` で止める
- **`excerpt` / `note` は残す。** apply = 抜粋ごと公開判断。public 行になるので akashic 内では誰でも読める。したがって **public 行の `excerpt` は公開してよい内容に限る**（機密アセットの抜粋を機械的に public にする経路は無い。人間が画面で confidential 以上を apply するときは抜粋の内容を見て判断する）
- **API キー経路の応答（`src/lib/domain/article-api.ts`）は `internal` より上の `pending` 行を返さない。** `Article.body` の書き込みには classification のガードが無いので、apply できない抜粋を AI に見せると「本文に貼る」だけで公開経路になる。見せなければ貼れない
- 脚注番号は `nextSourceNo`（既存の非 pending 行の `sourceNo` と本文の `^[n]` の最大 + 1。本文側も見るのは、宛先の無い脚注に新しい出典が黙って結びつくのを防ぐため）、並びは `nextSortOrder`（非 pending 行の末尾。`buildFrontmatter` は `sortOrder` → `sourceNo` で並べる）。`label` が空なら Asset のタイトル、`url` / `date` は捏造しない
- Article に `dirty = true` / `editedAt = now` を立てる（下の規約）。`updateMany` の where に呼び出し側が読んだ `updatedAt` を入れ、0 行なら**トランザクションごと巻き戻して `conflict`**。apply 自身が `updatedAt` を進めるので、別の apply が割り込んで番号がズレる競合もこれで検出される。呼び出し側は apply → 本文に `^[n]` の順で書く（逆だと途中で止まったとき宛先の無い脚注が残る）
- 監査ログは `article.source.apply`（API は metadata に `apiKeyId`、MCP はさらに `mcp.apply_article_source`）

**再取り込みは applied 行を frontmatter から作り直す**（全置換）ので、そのままだと 2 つが消える。取り込みは既存の非 pending 行を `assetId + sourceNo` で突き合わせ（`reconcileSources`、`src/lib/articles/reconcile.ts`）、

1. 対応した行の `excerpt` / `note` を新しい行に写す。`sourceNo` の無い行はそのアセットが双方 1 行だけのときに限る（取り違えて別の脚注に別の抜粋を付けるより、消える方がまし）
2. 対応が無く、**akashic で applied にしたが上流に無い行**（`applied && originalRef IS NULL && assetId あり` = apply したが未 push のまま上流が変わった）は削除せず **pending に戻す**（`demotableSources`。`sourceNo` を外し、classification を Asset の現在値に）。PR3 より前は同じ行が pending として生き残っていたので、その挙動を保つ。本文の `^[n]` はファイルで上書きされて消えているので、取り込みの出力に一覧を出して反映し直させる

### 一括 push の仕組み（`/articles/push`）

- **admin のみ。** 公開リポジトリへの書き込みなので、他の書き込み系（admin / member）より狭い
- 認証は fine-grained PAT（`ARTICLES_GITHUB_TOKEN`、sekai-nina-public だけに Contents: Read and write）。クライアントは `src/lib/github/client.ts` の素の `fetch`。**1 回の push = 1 コミット**（Git Data API）。Contents API で記事ごとにコミットすると、push のたびに GitHub Actions が Cloudflare Pages を再ビルドするので記事数ぶんデプロイが走る
- **`dirty` の意味は「DB から組み立てた Markdown ≠ GitHub 側のファイル」。** akashic での編集だけでなく、取り込み直後にも立つ（値が同じでも引用符・キー順が違えば push で差分が出るため。`dirtyAfterImport`）。初回の全件正規化もこの画面から出す
- **`editedAt` の意味は「akashic 側に未 push の編集がある」（非 null ⇔ ある）。** `dirty` だけでは正規化差分と編集を区別できないので分けている（#89）。編集の保存（`updateArticle`）が `dirty = true` と一緒に now を書き、push で `dirty` を落とす行は同時に null に戻す。取り込みは下記のとおり preserved 以外を null に戻す
- **衝突検出は `Article.githubSha`（取り込み時にファイルから計算した git blob SHA）と main の tree の突き合わせ**（`planPush`）。tree にある path の SHA が違えば「取り込み後に上流が変わった」、`githubSha` が null なら「blob SHA を埋める取り込みをしていない」で、どちらも衝突として除外する。衝突と `blocked` の記事だけ外して残りを 1 コミットにする（全体は止めない）。解消は DB でマージせず、pull した checkout から再取り込みして DB 側を作り直す
- ref の更新は non-force。tree を読んでから commit するまでにブランチが進んでいれば 422 で失敗する（同時 push の検出）。ref 更新のレスポンスだけ取りこぼした場合は先頭を読み直し、作ったコミットになっていれば成功扱い
- push 後は `githubSha` を新しい blob SHA に、`lastPushedAt` を今にする。`dirty = false`（と `editedAt = null`）は **組み立てた時点から `updatedAt` が変わっていない行だけ** に落とす（commit 中に編集された記事は dirty のまま残す）。更新は素の SQL 1 文（`UPDATE … FROM (VALUES …)`）で、`@updatedAt` は動かさない = push は編集ではない
- DB の更新は commit の **後** にまとめる。commit が失敗したら DB は何も変わらない。commit 成功後に DB 更新が失敗した場合は例外にせず `dbError` で返し、画面はコミット URL と一緒に見せる。次回は `githubSha`（古い）≠ tree で衝突扱いになり二重には書かない（再取り込みで解消）
- 表示用の計画（`previewArticlePush`）は実行時に使い回さず、`pushDirtyArticles` が commit 直前に組み立て直す
- push は `AuditLog` に `article.push` として残す（コミット SHA と件数）

### 取り込み側のガード（`pnpm cli:import-articles`）

akashic が記事の真実になると、古い checkout から取り込むと DB の未 push 編集がファイルで巻き戻ります。取り込みは次の 2 つで守っています。

- **ファイルの blob SHA == DB の `githubSha` かつ path も同じ かつ `editedAt` が非 null の記事はスキップ**（上流が変わっていない = DB の編集の方が新しい）。SHA が違えば上流が新しいのでファイルで上書きし、akashic の編集を捨てた記事（`editedAt` が非 null だったもの）は最後に一覧で知らせる。`dirty` ではなく `editedAt` で見るのは、正規化だけの dirty まで守ると `--create-missing` や照合のやり直しが push まで効かなくなるため。path も見るのは、内容そのままのリネームをスキップすると DB が旧 path のまま残って push が `deleted_upstream` で衝突し続けるため。スキップしなかった記事は `editedAt` を null に戻す（値がファイルと同じで書き込みを省いた経路も同様）
- **`--apply` は checkout の HEAD が origin/main と一致しない・`--dir` がリポジトリのトップレベルでないと止まる**（`compareCheckoutWithRemote`）。承知の上なら `--allow-stale`。dry-run でも同じ検査を警告として出す。未コミットの変更があるファイルは警告だけ（取り込むと push で衝突扱いになる）

**push の出力に影響する書き込みは必ず `Article.dirty = true` と `editedAt = now` を立てること**（本文・frontmatter カラム・`ArticleSource` の `applied` / `public` への遷移）。`dirty` を立て忘れると push 画面に出ず、GitHub と DB が食い違ったまま気づけません。`editedAt` を立て忘れると、次の取り込みがその編集をファイルで黙って上書きします。現状この書き込みをするのは `updateArticle` / `patchArticle`（編集 UI と API の保存）と `applyArticleSource` の 3 つで、いずれも `src/lib/domain/articles.ts`。

### 記事の編集 UI（`/articles/[shortId]/edit`）と API（`/api/v1/articles`）

- UI は admin / member のみ（viewer は詳細へ redirect）。触れるのは本文とモデル化済みの frontmatter（title / type / tags / 日付系 / draft / unlisted / ongoing）。`frontmatterExtra` と `ArticleSource` はここでは触らない
- 保存（`updateArticle`）は **変わっていなければ書かない**（`diffArticleEdit`。dirty / editedAt を無駄に立てない）。書くときは変更カラム + `dirty = true` + `editedAt = now`。プレビュー（`previewArticleAction`）も保存と同じ役割に絞る（remark + KaTeX を誰でも回せる経路にしない。本文の上限 `BODY_MAX_LENGTH` も共通）
- **楽観ロック**: フォームが読み込んだ時点の `updatedAt` を `updateMany` の where に入れ、0 行なら衝突として入力を残したまま拒否する。push は `updatedAt` を動かさないので push を挟んでも保存できる
- フォーム値の変換は `src/lib/articles/edit.ts` の純粋関数（vitest あり）。本文は `\r\n → \n` と先頭空行の除去だけ正規化し（`parseArticle` と同じ）、末尾は触らない。日付は `<input type="date">` の date-only を `parseFrontmatterDate` で UTC 深夜にする（取り込みと同じ規則。ここを変えると編集しただけで push に差分が出る）
- **API（REST `PATCH` / MCP `akashic_update_article`）は同じ経路に合流する。** `ArticleEditPatchSchema`（`src/lib/articles/patch.ts`、zod。未知キーは除去）で検証した部分更新を現在値に重ねてフォームの形にし（`mergeArticleEditPatch`）、UI と同じ `parseArticleEditForm` → `updateArticleFrom` を通す（`patchArticle`）。`updatedAt` は API では body で必須（`UpdatedAtSchema`）。API は権限（`write`）だけを見て role は見ない（既存の REST と同じ）
- 監査ログ（`article.update` / `article.source.apply`）は domain が `ArticleActor`（`id` + API キーなら `apiKeyId`）から書く。REST / MCP / 画面の 3 経路で書き分けない。MCP はさらに `mcp.<tool>` を 1 本足す
- `Article` は非保護テーブルなので、API から本文を書くこと自体には classification のガードが無い。保護アセットの抜粋が公開記事に入る経路のガードは apply 側（上の「紐づけの反映」）で、AI は抜粋を **apply できた出典だけ** 本文に書く前提

## DB 接続の構成

```
prisma          → DATABASE_URL → app_runtime（RLS 適用）
prismaInternal  → DIRECT_URL   → postgres（RLS バイパス）
```

`prisma` を使う限り、RLS が自動で効きます。ただし `withClearance` でクリアランスを設定しないと、何も見えません（フェイルセーフ）。
