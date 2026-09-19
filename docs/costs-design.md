# LLM コスト管理 (`/costs`) 設計書

> 2026-09 策定 (#117)。LLM を呼ぶ場所が 6 つに分かれていて、どこにいくらかかっているか・クレジットがあとどれだけ残っているかが分からなかった。akashic に集約し、「補充したほうがいいか」を `/status` 経由で Discord に流す。

## 0. 呼んでいる場所

| 呼び手 | プロバイダ / モデル | 用途 | 自己申告の `feature` |
|---|---|---|---|
| akashic `src/lib/domain/testimonials.ts` | OpenAI `gpt-4o-mini` | 口コミ抽出 | `akashic.testimonials` |
| bot `blog_watch/discovery.py` | OpenAI `gpt-5.4-mini` | 今日の発見の抽出 | `bot.discovery`（PR2） |
| bot `ocr/ai_provider.py` | OpenAI `gpt-5.2` | 画像 OCR | `bot.ocr`（PR2） |
| bot `github_sync/ai/openai_impl.py` | OpenAI `gpt-4o` | メッセージ解析 | `bot.github_sync`（PR2） |
| sekai-nina-ai-worker | Gemini `gemini-3.1-flash-lite` / `gemini-embedding-2` | サイトのふぃたん | `worker.fitan_site`（PR3） |
| office-nitan | Anthropic `claude-sonnet-4-6`（Claude Code） | Discord のふぃたん | 改修せず、Anthropic の API 側で捕捉 |

## 1. データの取り方（2 系統）

| 系統 | 何を取るか | 長所 | 短所 |
|---|---|---|---|
| **プロバイダ API**（`LlmCostDaily`） | Admin キーで引いた日次の**確定金額** | コードを通らない利用（手元の Claude Code 等）も含めて全部拾える | 機能別の内訳は粗い。Gemini は実質取れない |
| **自己申告**（`LlmUsageDaily`） | 各呼び出し側が報告したトークン数 → 単価表で USD に換算 | 機能 × モデルの内訳が出る。3 社を同じ形で扱える | コードを通る分しか拾えない。金額は推定 |

**確定金額が正。** 日次の支出は `LlmCostDaily` を優先し、その日の行が無ければ自己申告の合計で埋める（Gemini はこちらだけ）。

### プロバイダ API の実態（2026-09 に確認）

| | 日次コスト | 残高 |
|---|---|---|
| OpenAI | `GET /v1/organization/costs`（**Admin キー**、日次、`amount.value` は USD） | **API 無し** |
| Anthropic | `GET /v1/organizations/cost_report`（**Admin キー**、日次、**`amount` はセント建ての文字列**なので 100 で割る）。内訳は `usage_report/messages` を `api_key_id` + `model` で group | **API 無し** |
| Gemini | Cloud Billing のレポート / BigQuery エクスポート（最大 24h 遅延）。実質使えない | AI Studio の画面にのみ表示 |

Admin キー（`OPENAI_ADMIN_KEY` / `ANTHROPIC_ADMIN_KEY`）は**通常の API キーとは別物**。未設定ならそのプロバイダは黙ってスキップし、`/costs` に警告を出す。

`ANTHROPIC_KEY_FEATURES` に `{"apikey_01...": "nitan.discord"}` の JSON を置くと、Anthropic の内訳のキー ID を機能名に読み替える（ふぃたん Discord と手元の Claude Code を分けるため）。未設定なら `anthropic:<key id>` のまま出る。

## 2. データモデル（非保護、素の `prisma`）

| モデル | 役割 |
|---|---|
| `LlmUsageDaily` | `date` × `provider` × `model` × `feature` × `source` の一意キーで日次に積む。トークン各種 / `requests` / `costUsd?` |
| `LlmCostDaily` | `date` × `provider` の確定金額 |
| `CreditSnapshot` | 観測した残高。`provider` / `observedAt` / `balanceUsd` / `note` |

- **金額はトークン数に対して線形なので、行の金額も差分を足すだけでよい**（`increment`）。単価表に無いモデルは `costUsd` を null のままにする。SQL の `NULL + x` は `NULL` なので「不明」が伝播する
- プロバイダの usage API 由来の行（`source = provider`）は取り込みのたびに**全削除 → 作り直し**（同じ日を何度取り込んでも二重に積まない）。自己申告の行には触らない

## 3. 単価表（`src/lib/costs/pricing.ts`）

USD / 100 万トークン。**自己申告の換算にだけ使う**（確定金額は通さない）。

- **表に無いモデルは金額を出さない（null）。** 近いモデルの値を当てると「安く出ているから大丈夫」と誤読する。未登録は `/costs` に警告として出す
- 日付サフィックス（`claude-sonnet-4-6-20260514`）と `models/` 接頭辞は落として引く。**任意の前方一致はしない**（`gpt-5.7` が `gpt-5` に当たって古い単価で黙って計上されるのを防ぐ）
- Anthropic のキャッシュ読み出しは入力の 1/10（Fable だけ $0.25/MTok）。単価が分からないプロバイダは入力と同じ単価で見積もる（**高めに出す**）
- Gemini 3.x は 2026-12-31 までの料金。年明けに見直す

## 4. 残高と「補充したほうがいい」の判定

残高を返す API は 3 社とも無いので、**観測した残高から支出を引いて推定する**。

- 推定残高 = 最新 `CreditSnapshot` − **その日を含む**それ以降の支出。目視した時点でその日の支出の一部は残高に反映済みなので二重に引くが、**多めに引く方に倒す**（少なく引くと残高を多く見せ、補充の警告が遅れる = この機能の存在意義を損なう）
- 支出を引く窓は**スナップショットの古さに合わせて広げる**。画面の 30 日だけで引くと、45 日前のスナップショットから 15 日分の支出が消えて残高を多く見せる（`judgeCredit` が unknown にするのは 60 日を過ぎてからなので、その間ずっと嘘をつく）
- バーンレート = 直近 7 日の 1 日あたり平均。**当日は途中経過なので除く**。使わなかった日も 0 として数える（支出のあった日だけで割ると、週 1 回しか動かない処理でバーンレートが 7 倍に出て「あと 1 日」と誤報する）
- 残り日数 = 推定残高 ÷ バーンレート（切り捨て）
- 判定（`judgeCredit`）: 残高未登録 / スナップショットが 60 日以上前 → **unknown**（障害ではなく入力待ち）、残高 0 以下 → **error**、残り 7 日未満 → **error**、14 日未満 → **warn**、消費なし → **ok**

### `/status` との関係

`costs.<provider>` チェックとして `/status` に相乗りする（確認 13 分・24h リマインド・Discord 通知がそのまま効く）。

- **要約に金額を入れない。** この 1 行は Discord にも流れるので、残高そのものは `/costs`（admin のみ）でだけ見せる
- `/status` 上でもコストのグループは **admin にだけ表示**する

## 5. 画面 `/costs`（**admin のみ**）

- プロバイダ別カード: 今月の支出 / 1 日あたり / 推定残高 / 残り日数 / 残高を記録した日時
- 日次の推移（30 日）
- 機能 × モデルの内訳（30 日、金額の降順）
- 残高スナップショットの入力フォーム + 「今すぐ取り込む」
- Admin キー未設定・単価表に無いモデルの警告

## 6. 取り込み

Vercel Cron が 1 日 1 回 `GET /api/cron/costs` を呼ぶ（`CRON_SECRET`、`/api/cron/status` と同じ保護）。**確定遅れに備えて毎回 3 日分を上書きする。**

## 7. 環境変数

| 変数 | 用途 |
|---|---|
| `OPENAI_ADMIN_KEY` | OpenAI の組織 Admin キー。未設定なら OpenAI の確定額を取り込まない |
| `ANTHROPIC_ADMIN_KEY` | Anthropic の Admin キー（`sk-ant-admin...`）。同上 |
| `ANTHROPIC_KEY_FEATURES` | `api_key_id` → 機能名の JSON（任意） |

## 7.5. 権限（PostgREST から見えないようにする）

Supabase は public スキーマの全テーブルに `anon` / `authenticated` への DML を既定で与え、PostgREST (`/rest/v1/<table>`) がそれを外に出す。**保護テーブルが守られているのは RLS のおかげで、権限のおかげではない**（ポリシーが `TO app_runtime` なので他のロールはどのポリシーにも一致せず 0 行になる）。

RLS を張らない非保護テーブルにはその守りが無いため、`20260919020000_revoke_anon_on_unprotected` で `LlmUsageDaily` / `LlmCostDaily` / `CreditSnapshot` と、`/status` の `Job` / `JobRun` / `StatusCheckState` から `anon` / `authenticated` の権限を剥がした（akashic は PostgREST を使わず Prisma が `app_runtime` で直接つなぐので影響は無い）。

**非保護テーブルを足すときは毎回 REVOKE を書く。** 書かないと publishable key で読み書きできる。

## 8. 既知の限界・今後

- Gemini は確定額を取り込めない。サイトのふぃたんの自己申告（PR3）だけが頼りで、無料枠の範囲内かどうかは AI Studio の画面で見るしかない
- office-nitan（Claude Code）は自己申告しない。Anthropic の確定額には出るが、内訳は `api_key_id` 単位までしか分からない
- 為替は扱わない（すべて USD）
- **プロバイダ由来の「日」は UTC 日**（両社ともバケットを UTC 深夜で切る）。JST 09:00〜翌 09:00 にあたるので、自己申告（true JST）とは最大 9 時間ずれる。月末の端数が動く程度なので日次の推移とバーンレートの用途では許容している
- 機能 × モデルの内訳は**自己申告とプロバイダ由来を足し合わせない**（同じ利用が両方に出る）。画面では「出どころ」列で分けている
- 単価表は**日付サフィックスを落とした一致までしか許さない**。`gpt-5.7` が `gpt-5` に当たって安い単価で黙って計上されるのを防ぐため、知らないモデルは「価格未登録」に倒す
- 単価表は手で更新する。モデルを増やしたら `pricing.ts` に足す（足し忘れは `/costs` の「価格未登録」で気づける）
