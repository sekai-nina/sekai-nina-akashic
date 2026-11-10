# パフォーマンスの鉄則

画面の表示・ボタン操作を遅くしないためのルール。**新しく書くコードはこれに従い、レビュー (`/review` の performance 観点) でもこれを基準にする。**

akashic の遅さは、ほぼ次の 4 つから来ている (2026-11 の棚卸しで実測)。

| 原因 | 典型 | 効き方 |
|---|---|---|
| 同じ画面を 2 回描く | Server Action の後に `router.refresh()` | ボタン 1 回の待ち時間がほぼ倍 |
| DB の往復を 1 つずつ待つ | `withClearance` を `await` で縦に並べる・ループの中で `await` | 往復の数だけ足し算で遅くなる |
| RLS 越しに大きな表を数える | `_count` / `count` / `groupBy` を `withClearance` の中で | 数秒〜十数秒 (AssetEntity 約 37 万行) |
| 画面が全部そろうまで何も出さない | 脇のパネルの問い合わせを本体と一緒に `await` | いちばん遅い問い合わせが画面全体の待ち時間になる |

## 書くときのルール

### 1. Server Action の後に `router.refresh()` を重ねない

Next 16 では、Server Action の中で `revalidatePath()` / `updateTag()` / `refresh()` (`next/cache`) を呼ぶと、**Action の応答に今の画面の描き直しが入って返ってくる**。クライアントでさらに `router.refresh()` を呼ぶと、同じ画面をもう一度最初から描く。

- Action で `revalidatePath` しているなら、クライアントの `router.refresh()` は書かない
- `invalidateAssets()` などの `revalidateTag(tag, "max")` は**描き直しを返さない** (古い値を返しつつ裏で更新する)。保存直後に画面へ反映したいときは、クライアントの `router.refresh()` ではなく Action の中で次のどちらかを呼ぶ。往復が 1 回で済む
  - 画面が**そのタグのキャッシュを読んでいて、保存した値をすぐ見せたい** → `updateTag(tag)` (すぐ捨てて描き直しも返す。前例: `src/lib/cache.ts` の `expireEntities`)。`"max"` + `refresh()` だと、描き直しはしても**キャッシュは古いまま**なので保存前の値が出る
  - 画面がキャッシュを通さずに読んでいる (または件数バッジなど少し古くてよい) → `refresh()` (`next/cache`)。前例: `src/app/(main)/faces/actions.ts`
- 小さなトグル (チェック・既読など) は、Action が返した値で手元の状態を更新する (`useOptimistic` / `useState`)。画面全体の描き直しは要らない
- **`src/lib/perf-rules.test.ts` が見張っている。** 許可した場所以外で `router.refresh()` を書くと `pnpm test` が落ちる。要るなら理由を添えて許可の表に足す
- 根拠: `node_modules/next/dist/server/app-render/action-handler.js` (`pathWasRevalidated` が立っていると描き直しを返す)、`.../spec-extension/revalidate.js` (`revalidateTag` に `"max"` などの profile を渡すと立てない)

### 2. DB の往復を縦に並べない

`withClearance` / `withSession` は 1 回ごとに `BEGIN`・`set_config`・本体・`COMMIT` の往復がある。手元から本番へは 1 往復 70ms 前後 (2026-11-10 実測)。Vercel (hnd1) からは短いが 0 ではなく、本数が増えれば足し算で効く。

- **互いに依存しない読み取りは `Promise.all` で同時に投げる。** 前の結果の ID が要るものだけ後ろに回す (詳細ページで「本体 → 関連」を待つとき、関連が本体の `id` だけで引けるなら、URL の `id` で最初から並べる)
- **1 つのトランザクションの中の `Promise.all` は並列にならない** (接続が 1 本なので順番に流れる)。軽い問い合わせ数本ならまとめて 1 本のトランザクションに入れて `BEGIN`/`COMMIT` を節約し、重い問い合わせ同士は別のトランザクションにして `Promise.all` で並べる
- **ループの中で `await` しない (N+1)。** `findMany({ where: { id: { in } } })`・`createMany`・`updateMany`・`groupBy` でまとめる。値が行ごとに違う一括更新は `UPDATE … FROM (VALUES …)` の生 SQL 1 本にする
- **書き込みの前の確認 (`requireClearanceForAsset` など) は、書き込みと同じトランザクションの中で行う。** 確認だけのためにトランザクションを 1 本増やさない
- 1 画面で同時に張るトランザクションは数本に抑える。接続プールは 1 インスタンス 10 本 (`src/lib/db.ts` の `RUNTIME_CONNECTION_LIMIT`) で、**同じインスタンスに来た同時リクエスト (プリフェッチを含む) と分け合う**。超えた分は空き待ちで並ぶ

### 3. RLS 越しに大きな表を数えない

`_count` / `count()` / `groupBy` / `aggregate` を `withClearance` の中で `Asset` / `AssetEntity` / `SourceRecord` / `AssetText` / `FaceDetection` などの大きな表に当てると、行ごとに RLS の判定が走って数秒かかる。

- 件数は `prismaInternal` + `classificationFilter` / `classificationFilterSql` で数えて `unstable_cache` に置く (前例: `src/lib/cache.ts` の `getCachedEntityAssetCounts`)
- **bot の取り込みのたびに消えるタグ (`assets` など) を、重い集計のキャッシュに付けない。** 付けるとほぼ毎回ミスになる。`revalidate` の秒数だけで更新する (前例: 同じく `getCachedEntityAssetCounts` のコメント)
- 一覧の件数バッジのために詳細ページで `_count` を取らない。キャッシュ済みの件数を `withAssetCount` で埋める

### 4. 要る列・要る行だけを引く

- 一覧で本文 (`AssetText.content`・`Article.body`)・全版 (`AssetTextRevision`)・深い `include` を引かない。`select` で画面に出す列だけにする。抜粋が要るなら SQL の `substring` で切る
- `findMany` には `take` を付ける。件数が増え続ける表 (ツイート・ヒット・ジョブ履歴) はページングする
- Client Component に渡す props はそのままブラウザに送られる。全文を渡さない
- `ILIKE` / `contains` / `mode: "insensitive"` を保護テーブルに当てない (RLS 下では必ず全件走査。CLAUDE.md の PGroonga の節)。並び替えに使う列には索引を張る

### 5. 画面の本体を先に出す

- ページの `await` は「見出しと本体」に要るものだけにする。脇のパネル (企画・クリップ・顔・件数・おすすめなど) は **async の Server Component に切り出して `<Suspense>` で包む**。届いた順に埋まる
- **詳細ページ (`[id]` など) には自前の `loading.tsx` を置く。** 無いと一覧の骨組みが出たり、前後の詳細へ移るときに何も反応しなかったりする
- `(main)/layout.tsx` (サイドバー) で DB を待たない。全ページの待ち時間に乗る

### 6. ブラウザに送る JS を太らせない

- CodeMirror・Leaflet・recharts のような重いライブラリは `next/dynamic` で読み込む (前例: `places-map.tsx`)
- サイドバーなど全ページで読み込むクライアント部品から、`@prisma/client` などサーバー向けのモジュールを値として import しない (型だけなら `import type`)
- `<Link prefetch>` を一覧の全リンクに付けない。プリフェッチは 1 本ごとにサーバーで描画が走り、接続プールを食う (`src/components/sidebar.tsx` の `NavLink` の方針)

## 計り方

勘で直さず、直す前と後に計る。

### 本番の所要時間 (Vercel metrics)

```bash
# リポジトリの外で実行する (worktree では --project を受け付けない)
cd /tmp && vercel metrics vercel.function_invocation.function_duration_ms \
  --scope root2116s-projects --all --prod -s 14d -a p90 --group-by route -l 300 --json \
  -f "project_name eq 'sekai-nina-akashic' and request_method eq 'GET'"
```

- 出力の先頭に CLI の表示が付くので、最初の `{` から JSON として読む
- **`request_method` で分ける。** `GET` がページ表示、`POST` が Server Action (ボタン操作)。分けないと混ざる
- **p50 は当てにならない。** ページの GET の大半はプリフェッチ (`loading.tsx` までの軽い描画) なので 10ms 前後に潰れる。**p90 / p99 を見る**
- `--group-by function_start_type` でコールドスタート (`cold`) とそれ以外を分けられる
- `server_action_name` で Action ごとに分けられるが、名前が付かない Action が多い

### 遅いトランザクションのログ

`withClearance` / `withSession` が 1 秒を超えると `[slow-tx] <ms> <呼び出し元>` をログに出す (`src/lib/db.ts` の `logIfSlow`)。本番ではスタックがまとめられたファイル名になって読みにくいので、**どのページかはログの行に付くリクエストのパスで見る**。手元の `pnpm dev` ではソースの場所が出る

```bash
cd /tmp && vercel logs --scope root2116s-projects -p sekai-nina-akashic --environment production \
  --since 1d -q "slow-tx" -n 100 --json
```

### 手元から本番 DB で計る

読み取りだけのスクリプトを `npx tsx ./.tmp-x.ts` で流す。**ガードのフックは存在しないファイルを止めるので、先に Write で作ってから別のコマンドで実行する。** 計り終えたら消す (コミットしない)。

- 手元から本番への 1 往復は 70ms 前後で、Vercel からより大きい。**往復の多さは手元だと大きく見える。** 改善前後の比で判断する
- 書き込みを含むスクリプトは流さない
