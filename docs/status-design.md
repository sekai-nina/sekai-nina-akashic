# パイプライン監視 (`/status`) 設計書

> 2026-09 策定 (#100)。discord-bot の「今日の発見」自動抽出が 2 ヶ月止まっていたことに誰も気づけなかったのがきっかけ。収集・加工の結果が集まる akashic に「今どこまで最新か / 何が失敗しているか」を俯瞰する場所を置き、変化は Discord に流す。

## 0. 収集カバレッジ (`/coverage`) との役割分担

| | `/coverage` | `/status` |
|---|---|---|
| 問い | **アーカイブに抜けが無いか**（この観点で、このソースのアイテムを全部確認したか） | **自動化が生きているか**（収集・加工が今も最新まで動いているか、失敗していないか） |
| 単位 | 観点 (Lens) × DataSource × アイテム（ブログ 1 本・トーク 1 日分・番組 1 回） | パイプライン（bot のジョブ・加工処理・記事の同期） |
| 誰が更新 | 人（チェックを付ける） | 機械（15 分ごとの cron） |
| 時間軸 | 過去に遡って「〜◯日まで反映済み」 | 今この瞬間の鮮度と直近の失敗 |
| 通知 | なし | Discord |

共有するのは `DataSource` だけ。`/status` の「収集」グループは `DataSource.publisherPattern` を借りて「そのソースの SourceRecord が最後に増えたのはいつか」を出す。**status が緑 = 素材は流れ込んでいる**、**coverage が埋まっている = 人がその素材を観点ごとに確認済み**。status が warn なら coverage を埋めようにも素材が無い。`/status` の収集セクションから `/coverage` へリンクしている。

## 1. 検知の 2 系統

| 系統 | 何を見るか | 長所 | 短所 |
|---|---|---|---|
| **データ由来** | akashic の DB から導出（最終登録・未処理件数・GitHub との差） | 報告側の改修が不要。結果の正しさを直接見る | 「新着が無いだけ」と「収集が死んだ」を区別できない |
| **ハートビート** | bot / ワーカーの各ジョブが実行ごとに `POST /api/v1/jobs/{key}/runs` で報告 | プロセスの生存と失敗理由が届く | 報告側の改修が要る（sekai-nina-discord-bot#30） |

両方を使う。データ由来が「結果」、ハートビートが「プロセス」。片方だけだと今回のような「bot は生きているが 1 機能だけ無効」を見落とす（ブログ登録は動いていたので鮮度は正常、抽出だけ止まっていた）。

## 2. データモデル

いずれも件数・時刻・メッセージしか持たない運用情報なので**非保護**（RLS 対象外、素の `prisma`）。

| モデル | 役割 |
|---|---|
| `Job` | ハートビートの受け口。`key` (unique) / `name` / `intervalSec` / `lastRunAt` / `lastOkAt` / `lastStatus` / `lastMessage`。初回の報告で自動作成（upsert） |
| `JobRun` | 実行履歴。`status` (ok/error) / `message` / `count` / `durationMs`。**ok で count 無しの報告は、最新の行から 1 時間以内なら行を増やさない**（60 秒 poll の blog_watch で 1 日 1,440 行にしない。静かな成功は 1 時間に 1 行）。30 日で自動削除 |
| `StatusCheckState` | チェックごとの現在状態。`key` / `group` / `name` / `description` / `notify` / `status` (ok/warn/error/unknown) / `summary` / `detail` (Json) / `since` / `evaluatedAt` / `lastNotifiedAt` / **`notifiedStatus`**（最後に通知できた status）。**通知の遷移判定と `/status` の表示はこれだけを読む** |

`StatusCheckState` に名前とグループを写しているのは、`/status` が保護テーブル（`DataSource`）を読まずに描けるようにするため。ページは cron が保存したスナップショットを出すだけで、評価は走らせない。

**見せてよい範囲**: 評価は `prismaInternal` で数えるが、結果はログイン済み全員に見える。`detail` に写す名前・タイトルは **`internal` 以下の行に限る**（`STATUS_VISIBLE_CLEARANCE`。今日の発見の SQL に `classificationFilterSql("internal")`、鮮度チェックは public / internal の `DataSource` だけ）。confidential 以上は件数にも入れない。

## 3. チェックの定義（`src/lib/status/checks.ts`）

定義と閾値はコードに持つ（DB に持っても結局クエリはコードに要る）。閾値は `src/lib/status/types.ts`。

| グループ | key | 判定 | 通知 |
|---|---|---|---|
| 収集 | `collect.<DataSource.key>` | `DataSource.publisherPattern` / `titlePattern` で `SourceRecord` を絞り、最終 `createdAt` が閾値を超えたら warn。閾値は `SOURCE_FRESHNESS_MAX_AGE_HOURS`（blog 72h / talk 48h / hinaai 10d。直近 60 日の最大ギャップの実測から）。**YouTube 系 (hinachan / official_ch) は #101 を直すまで外している** | ✓ |
| 収集 / 加工 / 外部ワーカー | `job.<Job.key>` | 未報告 → unknown。最終成功が `intervalSec × 3`（下限 15 分）を超えて古い → error（途絶）。最後の報告が error でも、**成功が `max(intervalSec, 15分)` 途絶えるまでは ok**（「直近の報告は失敗」を添える。一時的な失敗で ok ↔ error が往復して通知が 2 通ずつ出ないように）。`EXPECTED_JOBS` に無い key の報告も一覧に出る（外部ワーカー扱い） | ✓ |
| 加工 | `process.discovery_unextracted` | 坂井新奈のブログで本文に「今日の発見」（bot と同じ正規表現で「今日の発券」「今日発見」も拾う）・タグ無し・**直近 7 日**に登録。1 件以上で warn。発見なしの回（「今日の発見はお休み」）も乗るが 7 日で消えるので永久には警告しない | ✓ |
| 加工 | `process.thumbnails_pending` / `process.inbox_backlog` | 件数表示のみ（常に何件かあるので warn にしない）。サムネイルの条件は `src/lib/thumbnails` の `thumbnailPendingWhere()` を `pnpm cli:thumbnails` と共有 | ✗ |
| 記事 | `articles.dirty` | dirty の件数と最古の編集日（`editedAt`、無ければ `updatedAt`）。7 日超で warn | ✓ |
| 記事 | `articles.pending` | pending の紐づけ件数（表示のみ） | ✗ |
| 記事 | `articles.github_drift` | GitHub の tree の blob SHA と `Article.githubSha` を突き合わせ、GitHub 側が進んだ（消えた）記事・未取り込みの新規があれば warn「取り込みが必要」。`ARTICLES_GITHUB_TOKEN` 未設定なら unknown | ✓ |
| akashic 自身 | `system.internal_db` | `prismaInternal` で `Asset` が 0 件なら error。`DIRECT_URL` 未設定だと `DATABASE_URL` に無言でフォールバックして上のチェックが全件 0（fail-open）になるのを検知する番犬 | ✓ |

チェックを足すときは `CheckDefinition` を 1 つ書いて `getCheckDefinitions()` の配列に入れる。`detail` の形は `src/app/(main)/status/check-detail.tsx` が描ける形（`assets[]` / `articles[]` / `changed[]` / `added[]` / `lastAt` / `lastRunAt`）に揃える。各チェックは `CHECK_TIMEOUT_MS`（20 秒）で打ち切られ「評価に失敗」になる（GitHub が固まっても他のチェックの保存と通知を止めない）。

## 4. 評価と通知（`src/lib/status/evaluate.ts`）

- **Vercel Cron `*/15 * * * *` → `GET /api/cron/status`**（`vercel.json`）。`CRON_SECRET` の Bearer で保護し（定数時間比較）、未設定なら 503 で何もしない（fail-closed）。admin の「今すぐ評価」も同じ関数を呼ぶ。**直近 30 秒以内に評価済みなら何もしない**（cron と手動の重なりで二重通知しない）
- 全チェックを並列に走らせ、1 つの例外・タイムアウトは error として扱って他は続ける
- 前回と同じ status なら `since` を引き継ぐ。定義から消えた key の行は消す
- **通知の判定**（`decideNotification`）は**前回の status ではなく `notifiedStatus`（最後に通知できた status）と比べる**: ok/unknown → warn/error の第一報、warn ↔ error の変化、warn/error → ok の復旧、**warn/error のまま 24h 経過のリマインド**。unknown への遷移は出さない（トークン未設定などの構成の話）。`notify: false` のチェックは出さない
- 1 回の評価で複数変わっても **1 メッセージ**（`DISCORD_STATUS_WEBHOOK_URL`、素の `fetch`、行単位で 1900 字に収めて `/status` へのリンクは必ず残す）。送れたものだけ `lastNotifiedAt` / `notifiedStatus` を進める（**送信に失敗した遷移は次の評価で同じ遷移としてもう一度出る**）。通知の要らない行は `notifiedStatus` を今回の status に同期する
- bot の `message` は要約と Discord では 200 字に切る（`clipMessage`）
- 同じ cron で 30 日超の `JobRun` を消す

## 5. 画面（`/status`）

ログイン済みなら誰でも見られる（見せるのは internal 以下）。admin には「今すぐ評価」「通知テスト」を出す。

- 上部: 正常 / 注意 / 異常 / 不明 の件数と最終評価時刻
- グループ（収集 / 加工 / 記事 / 外部ワーカー / akashic 自身）ごとに 1 行 1 チェック。行 = ステータス・名前・要約・「〜から」（その状態になってからの経過）。展開で説明・detail（アセット / 記事へのリンク）・key・最終通知。収集には `/coverage`、記事には `/articles/push` へのリンク
- ハートビートの履歴: ジョブごとに直近 10 回

## 6. 環境変数

| 変数 | 用途 |
|---|---|
| `CRON_SECRET` | Vercel が cron 呼び出しの `Authorization: Bearer` に載せる。`openssl rand -hex 32` |
| `DISCORD_STATUS_WEBHOOK_URL` | 通知先の Incoming Webhook。未設定なら通知しない（評価はする） |
| `AUTH_URL` | 通知に載せる `/status` へのリンクの元 |

## 7. 既知の限界・今後

- ハートビートの送信側は sekai-nina-discord-bot#31 で対応済み（blog_watch / site_watch / youtube_watch / talk_monitor ×2 / discovery）。`bot.discovery` は抽出が起きるまで「未報告」
- どの write キーでもどの `key` にも報告できる（別 bot のキーで死んだ bot を健全に見せられる）。報告元の記録と制限は #102
- YouTube 系の `DataSource`（hinachan / official_ch）は `titlePattern` が youtube_watch の登録形式に合わず、カバレッジの導出も新着を拾えていない（#101）。直したら `SOURCE_FRESHNESS_MAX_AGE_HOURS` に戻す
- `articles.github_drift` は `short_id` の無い `.md`（取り込みが飛ばすもの）を「未取り込みの新規」に数える。今は該当なし
- `render-discovery.ts`（site 側でビルド時に今日の発見一覧を再生成）は #46 の「akashic が記事の真実」と衝突している。akashic 側に吸収するのが筋（別 Issue）
