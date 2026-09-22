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
- `SketchSetting`（スケッチ生成のプロンプトと画風の見本。**全体で 1 行**で、個人のデータではないので読み書きは固定のクリアランス（`MAX_EXTERNAL_AI_CLEARANCE`）で行う。操作者のクリアランスで読むと、低い人のときだけ無言で既定の文面に化ける）
- `XMentionWatch`, `XMentionSetting`, `XMentionHit`（X 言及監視。cron は `prismaInternal`、`/mentions` は `withClearance`）
- `Live`, `LivePerformance`, `LiveSong`（ライブ記事ワークフロー。`Live` は自前の classification、子 2 つは親 `Live` に従う。`MeetGreet` と同じく `withSession`。参考画像 `sketchRefs` とスケッチ候補も `MeetGreet` と同じ扱い → 下の「外部の AI に渡すもの」）
- `Anniversary`（記念日。出典アセットの本文は持たないが、機密アセットから作った記念日が漏れないよう自前の classification で守る）
- `InstaWatchTarget`, `InstaAccount`, `InstaStoryJob`（Instagram 監視。`InstaStoryJob` は iPad ワーカーのジョブで、人 / API キーからの読み書きは `withClearance`、キューの操作（失効・次の送信）は cron からも走るので `prismaInternal`）
- `TiktokWatchTarget`, `TiktokVideo`（TikTok 監視 #179。対象と「どの動画を取ったか」の台帳。画面 `/admin/tiktok` も bot 向け API `/api/v1/tiktok/*` も `withClearance`。`prismaInternal` で回す経路は無い）

`Article.dossierId`（素材ドシエ。#41）は非保護テーブルから保護テーブルへのポインタ。記事詳細で **ドシエ本体を出すときは `withSession` で引き直す**（private なドシエは所有者にしか見えない = 見えなければ出さない。ID があるからといって `prisma.dossier` を素で触らない）。書くときは `prisma.$executeRaw` で `dossierId` だけ更新する（`prisma.article.update` は `updatedAt` を進めて編集画面の楽観ロックを偽の衝突にする。push の出力にも影響しないので `dirty` も立てない）。

### クリップ（`/clips`、#41）

クリップ（記事未定の抜粋）は新しいテーブルではなく、**`kind = clips` の共有ドシエ 1 本の `DossierItem`**。RLS / GRANT / バックアップは Dossier 系がそのまま効く。

- プールは `viewMode` / `editMode` とも `clearance`、`internal`。クリアランスが足りる全員に見え、admin / member が書ける。public クリアランスにはプール自体が見えない（`findClipPool` が null）
- 全体で 1 本なのは部分ユニーク索引 `Dossier_clips_singleton`（Prisma は表現できないので `migrate diff` が `DROP` を提案しても捨てる。trgm / pgroonga と同じ扱い）
- 「ドシエにまとめる」= `DossierItem.dossierId` の付け替え。`dossieritem_update` ポリシーは USING が移動元・WITH CHECK が移動先のドシエを評価するので、**移動先の編集権限が無い付け替えは RLS でも止まる**（アプリ層の `requireEditAccess` と二重）
- **classification がプール（internal）より上のアセットはクリップできない**（`createClip`）。`DossierItem` の抜粋文はドシエの classification で見えるので、confidential の本文が internal の人に漏れる。これは既存の「ドシエに追加」にも無い検査なので、一般のドシエでは引き続き入れる人の責任
- プールは `listDossiers` / `listEditableDossiers` / ミーグリのドシエ候補から除外し、`updateDossier` / `deleteDossier` は `kind = clips` を拒否する（削除すると全員のクリップが消える。所有者にも許さない）。`/dossiers/[id]` は `/clips` へ redirect
- **`requireEditAccess` はプールを既定で拒否する。** ピッカーが隠していても Server Action の `dossierId` はクライアント入力なので、ここで止めないと「ドシエに追加」でプールに任意のアセットを入れられる（= `createClip` の classification 検査を素通りする）。プール内アイテムのメモ編集・削除だけ `allowClipPool: true` で通す。外部画像 API（`/api/v1/dossiers/:id/external-image`）と `createMeetGreet` も `kind` を見て拒否する
- 移動（`moveClips`）も移動先ドシエの classification とアセットの classification を突き合わせる。RLS の WITH CHECK はドシエしか見ないので、internal の抜粋を public のドシエへ移すと下位に見える。見えないアセット（後から機密が上がったもの）のクリップも移せない
- **アセットの機密を後から上げても、プールに入っている抜粋は消えない**（DossierItem の RLS は親ドシエしか見ない）。一般のドシエと同じ穴だが、プールは全員共有なので範囲が広い。機密を上げるときはプール（と各ドシエ）の抜粋を手で確認する
- バックアップ/リストア: `backup.ts` は全列を書くが、`restore.ts` は列を列挙して書くので **`Dossier.kind` / `Dossier.articleTemplate` / `Dossier.articleExclusions` と `DossierItem.createdById` を落とさないこと**（落とすとリストア後にプールが普通のドシエになり、次のクリップでプールが 2 本目できる）。`Article.dossierId` は Article がバックアップ対象外なので、リストア後は `pnpm cli:backfill-article-dossiers` で張り直す
- サイドバーの件数バッジは `getCachedClipCount(clearance)`（`withClearance`。`app.user_id` 無しでも `viewMode = clearance` のプールは RLS が通る）

**非保護テーブルを足したら `REVOKE ALL ON TABLE "<Table>" FROM anon, authenticated;` を migration に書く。** Supabase は public スキーマの全テーブルに `anon` / `authenticated` への DML を既定で与え、PostgREST (`/rest/v1/<table>`) がそれを外に出す。保護テーブルが守られているのは RLS が `TO app_runtime` のポリシーしか持たないからで、権限のためではない。

既存分は `20260919020000_revoke_anon_on_unprotected`（`Job` / `JobRun` / `StatusCheckState` / `LlmUsageDaily` / `LlmCostDaily` / `CreditSnapshot`）と `20260919030000_revoke_anon_on_article`（`Article`）で塞いだ。**現在 RLS 非対象のテーブルはすべて PostgREST から閉じている**ので、足すときに書き忘れるとそこだけ穴になる。akashic の supabase クライアント（`src/lib/supabase/*`）は auth 専用でテーブルを触らないため、剥がしてもアプリには影響しない。

`Announcement`（お知らせ `/announcements`）は公開サイトに出すための文章しか持たないので非保護（`Article` と同じ扱い。`20260920180000_announcement` で REVOKE 済み）。書けるのは admin / member（Server Action は `requireRole`、REST は write キー）。

`Song` / `Release` / `ReleaseTrack`（曲マスタ #167。曲名・収録シングル・発売日）は公式ディスコグラフィそのものなので非保護。`LiveSong` 側は保護されるので「どのライブで何を歌ったか」は漏れない（`/songs` の披露回数・披露した公演は `withClearance` で見える範囲だけ）。`Song.participation`（坂井新奈の参加楽曲か）も公開情報の範囲。`20260921000000_live` / `20260921100000_song_master` で `REVOKE` 済み。取り込みは `pnpm cli:import-songs`（`DIRECT_URL`）。

例外が **曲の統合 `mergeSongs`**（`/songs/[id]`、admin 限定）。誤字の曲を正しい曲に寄せるとき、`LiveSong` は `RESTRICT` なので見えないライブのぶんも付け替えないと消せない。そのため `prismaInternal` で付け替える。返すのは曲名だけで、付け替えた行の中身は返さない（件数は監査ログにだけ残す）。

`LlmUsageDaily` / `LlmCostDaily` / `CreditSnapshot`（コスト管理 `/costs`）も非保護。金額とトークン数しか持たないが、**画面と Server Action は admin のみ**に絞る（口座の残高なので member / viewer には見せない）。`/status` のコストのチェックも admin にだけ表示し、Discord に流れる要約には金額を入れない。

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

## 外部の AI に渡すもの（ミーグリ / ライブの抜粋提案・スケッチ生成）

ミーグリとライブ（#150 で同じ仕組みを共用）の 2 つの機能は、**アセットの中身そのものを OpenAI に送ります**。
処理本体は `src/lib/domain/sketch.ts` / `src/lib/domain/excerpts.ts` で、器（`MeetGreet` / `Live`）ごとの書き込み先だけを差し替えています。以下「ミーグリ」と書いてある縛りはすべてライブにも同じに効きます。

| 機能 | 送るもの | 送り先 |
|---|---|---|
| 抜粋の提案（`src/lib/meetgreet/excerpt.ts`） | ドシエに入っている本人ブログの**本文全文** | OpenAI |
| スケッチ生成（`src/lib/meetgreet/sketch.ts`） | ドシエで選んだ**画像**（Drive の原本を 1280px に縮小したもの）+ 基準スケッチ | OpenAI |
| 記事本文の生成（`src/lib/article-workflow/llm.ts`、#171 / #172。器を持たないドシエのスナップ・おでかけ・言葉） | ドシエのアイテムの**本文全文**（ブログ / トーク / 番組の文字起こし・説明）・抜粋・メディアのキャプション・人物エンティティ名・ドシエのタイトル。**画像しか入っていないブログは同じ URL の本文アセットも**（RLS 下で引くので見えない分は入らない）。おでかけは**場所候補**（名前・住所・Google マップ URL。編集メモは渡さない。昇格先の聖地が上限を超えるものは渡さない）も。加えて公開済み記事の**タイトル一覧**と**タグ一覧** | Anthropic |

**送ってよいのは `internal` 以下だけです** → `src/lib/meetgreet/config.ts` の `MAX_EXTERNAL_AI_CLEARANCE`。
記事本文の生成は `shapeDossierMaterials` が本文 (`text`) を付けるときにこの上限で見ており（`dossier-materials.ts`）、
上限を超えるアセットは記事にも載らない（`MAX_ARTICLE_CLEARANCE`）ので素材からも落ちます。
ドシエ自体が `internal` を超える場合は入口で止まります。

同じ理由で、**生成する記事の本文に載せてよいのも `internal` 以下だけ**です → `MAX_ARTICLE_CLEARANCE`。
`Article` は非保護テーブルで、本文（引用・トーク名・画像名）は push でそのまま公開リポジトリに載ります。
`confidential` 以上のアセットは本文にも出典にも出さず、落とした件数を画面に返して人が気づけるようにしています。
出典は `applyArticleSource` を通すので、公開に落とせる機密レベルの制限（`maxClassification`）もそのまま効きます。
`confidential` / `restricted` のアセットは候補にも出さず、ID を直接指定しても弾きます
（`classificationFilter(MAX_EXTERNAL_AI_CLEARANCE)` を、抜粋・スケッチ双方のクエリに入れている）。

記事の組み立ては器（`MeetGreet` / `Live`）を持たないドシエからもできます（#169 / #170、`Dossier.articleTemplate`）。
入口は `src/lib/domain/article-generate.ts` の `previewArticle` / `saveArticle` の 1 つで、上の線引き
（`MAX_ARTICLE_CLEARANCE`、`applyArticleSource` 経由の出典、`dirty` の規約）は器に依らず同じです。
ドシエが器のときは **保存にドシエの編集権限**（`canEditDossier`）が要り、記事は `Article.dossierId` で紐づきます。
テンプレートの実装状況は `src/lib/article-workflow/templates/index.ts`（登録簿）が正で、
未実装のものは「まだ使えません」で止まります。

RLS は「その人が読めるか」しか見ないので、**読める人が外に出せてしまうのを止めるのはアプリ層**です。
MCP の `akashic_apply_article_source` が公開判断を `internal` 以下に限っているのと同じ考え方で、
機械（LLM）に上位機密を触らせないための線引きです。上位機密のものを外部 AI に渡したくなったら、
まず分類を見直してください。

関連して、スケッチ生成が**アセット**から参照にできるのは**そのミーグリのドシエに入っている
画像だけ**で、抜粋の反映も**そのドシエに入っているアセットの本文だけ**を対象にします。
これを外すと、読めるアセットの中身を internal のドシエに写して下位に降ろせてしまいます。

例外は**その回だけの参考画像**（`MeetGreet.sketchRefs` / `Live.sketchRefs`、#159）です。「アーカイブに残す
価値は無いが、スケッチの参照には使いたい 1 枚」を、アセットにもドシエにも入れずに
R2 へ置いて使えるようにしたもので、次の 4 つで縛っています。

- **置き場に縛る。** 受け取るのは `meetgreet/<そのミーグリの id>/refs/`（ライブは `live/<id>/refs/`）配下の key だけ
  （`isRefKeyOf(kind, id, key)`。器の種類も見る）。R2 の任意のオブジェクトを参照に仕立てられると、見えないはずの画像を
  外部 AI に送る口になります。生成時と削除時の両方で確かめます
- **key はサーバーが作る。** アップロードの応答に載るだけで、クライアントからは指定できません
- **置けるのは member 以上**（`/api/meetgreets/:id/sketch-refs` / `/api/lives/:id/sketch-refs`。処理本体は `src/lib/meetgreet/sketch-ref-routes.ts`）。画面の Server Action と揃えています
- **ミーグリ自身の機密が `internal` を超える回には置けない／生成もできない。**
  アップロードした画像にはアセット側の機密検査が無いので、ここが唯一の歯止めになります。
  置いた時点で公開 URL の R2 に載るため、「生成のときに断る」では遅い

参考画像は**公開 URL の R2 に載り、署名もされません**（サムネイルやスケッチ候補と同じ）。
消しても `immutable` で配っているぶんはキャッシュに残りえます。生成した候補も `meetgreet/<id>/sketch/…` / `live/<id>/sketch/…` に公開 URL で置かれます。

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

**push の出力に影響する書き込みは必ず `Article.dirty = true` と `editedAt = now` を立てること**（本文・frontmatter カラム・`ArticleSource` の `applied` / `public` への遷移）。`dirty` を立て忘れると push 画面に出ず、GitHub と DB が食い違ったまま気づけません。`editedAt` を立て忘れると、次の取り込みがその編集をファイルで黙って上書きします。現状この書き込みをするのは `updateArticle` / `patchArticle`（編集 UI と API の保存）、`createArticle`（API の新規作成）、`applyArticleSource` の 4 つで、いずれも `src/lib/domain/articles.ts`。

### 記事の編集 UI（`/articles/[shortId]/edit`）と API（`/api/v1/articles`）

- UI は admin / member のみ（viewer は詳細へ redirect）。触れるのは本文とモデル化済みの frontmatter（title / type / tags / 日付系 / draft / unlisted / ongoing）。`frontmatterExtra` と `ArticleSource` はここでは触らない
- 保存（`updateArticle`）は **変わっていなければ書かない**（`diffArticleEdit`。dirty / editedAt を無駄に立てない）。書くときは変更カラム + `dirty = true` + `editedAt = now`。プレビュー（`previewArticleAction`）も保存と同じ役割に絞る（remark + KaTeX を誰でも回せる経路にしない。本文の上限 `BODY_MAX_LENGTH` も共通）
- **楽観ロック**: フォームが読み込んだ時点の `updatedAt` を `updateMany` の where に入れ、0 行なら衝突として入力を残したまま拒否する。push は `updatedAt` を動かさないので push を挟んでも保存できる
- フォーム値の変換は `src/lib/articles/edit.ts` の純粋関数（vitest あり）。本文は `\r\n → \n` と先頭空行の除去だけ正規化し（`parseArticle` と同じ）、末尾は触らない。日付は `<input type="date">` の date-only を `parseFrontmatterDate` で UTC 深夜にする（取り込みと同じ規則。ここを変えると編集しただけで push に差分が出る）
- **API（REST `PATCH` / MCP `akashic_update_article`）は同じ経路に合流する。** `ArticleEditPatchSchema`（`src/lib/articles/patch.ts`、zod。未知キーは除去）で検証した部分更新を現在値に重ねてフォームの形にし（`mergeArticleEditPatch`）、UI と同じ `parseArticleEditForm` → `updateArticleFrom` を通す（`patchArticle`）。`updatedAt` は API では body で必須（`UpdatedAtSchema`）。API は権限（`write`）だけを見て role は見ない（既存の REST と同じ）
- 監査ログ（`article.update` / `article.source.apply`）は domain が `ArticleActor`（`id` + API キーなら `apiKeyId`）から書く。REST / MCP / 画面の 3 経路で書き分けない。MCP はさらに `mcp.<tool>` を 1 本足す
- **新規作成（REST `POST /api/v1/articles` / MCP `akashic_create_article`）は `createArticle`。** 採番はサーバ側で行い、クライアントには `shortId` / `path` を指定させない（`src/lib/articles/create.ts`、vitest あり）。`shortId` は 7 桁 base62（公開サイトの `assign-slugs.ts` と同じ字母。公開サイトのビルドは `short_id` 欠落で落ちるので必ず振る。`@unique` 衝突は再採番）。`path` は `<type>/<ファイル名>.md` で、ファイル名はタイトルを NFC 正規化（#88）→ 制御文字除去 → `/ \ : * ? " < > |` を全角に置換 → trim したもの（タイトル側は NFC 正規化だけ。NFD のまま保存すると `[[タイトル]]` の完全一致解決から漏れる）。`.` / `_` 始まりと `readme` を含むファイル名は公開サイト（Astro / `EXCLUDED_SLUGS`）が無視するので 400。既定は `draft: true`。**これは公開サイトの記事ページに出さないだけで、push を止めるものではない**（本文は公開リポジトリに載り、後で消しても git 履歴に残る）。`Article` は非保護テーブルで本文の書き込みに classification のガードが無いのは下記のとおりで、作成 API はその範囲を「既存記事の本文」から「公開リポジトリに置くファイルの集合」へ広げる、`publishedAt` / `articleUpdatedAt` は今日（JST）。入力は PATCH と同じ `mergeArticleEditPatch` → `parseArticleEditForm` を通す。`githubSha = null` で作るので `planPush` が新規ファイルとして扱う。出典は作らない（#110）
- `Article` は非保護テーブルなので、API から本文を書くこと自体には classification のガードが無い。保護アセットの抜粋が公開記事に入る経路のガードは apply 側（上の「紐づけの反映」）で、AI は抜粋を **apply できた出典だけ** 本文に書く前提

## DB 接続の構成

```
prisma          → DATABASE_URL → app_runtime（RLS 適用）
prismaInternal  → DIRECT_URL   → postgres（RLS バイパス）
```

`prisma` を使う限り、RLS が自動で効きます。ただし `withClearance` でクリアランスを設定しないと、何も見えません（フェイルセーフ）。
