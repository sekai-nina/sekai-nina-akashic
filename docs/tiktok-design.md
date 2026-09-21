# TikTok 監視 (`/admin/tiktok` + tiktok-watch) 設計書

> 2026-09 策定 (#179)。日向坂46 公式 TikTok（`@hinatazakanews`、約 1,100 本・ほぼ毎日更新）を見張り、新着を DL して akashic に登録し、Discord に流す。Instagram（insta-watch）と同じ「bot が akashic をポーリングする」形だが、**「どの動画を取ったか」の台帳は akashic が持つ**。

## 1. 流れ

```
sekai (user systemd tiktok-watch.service)
  tiktok-watch watch
    ├ GET /api/v1/tiktok/targets                       対象と間隔
    ├ 対象ごとに (間隔 ± ジッター):
    │   ├ Playwright headless で https://www.tiktok.com/@<handle> を開き
    │   │   /api/post/item_list/ の JSON を横取り (id / createTime / desc / cover / duration)
    │   ├ POST /api/v1/tiktok/targets/<handle>/sightings → pending (DL すべき動画)
    │   └ pending ごとに:
    │       ├ yt-dlp で mp4 を DL (data/<handle>/<videoId>.mp4 + .info.json)
    │       ├ POST /api/v1/upload (4MB 超は initiate → Drive へ PUT → complete)
    │       ├ POST /api/v1/tiktok/videos/<videoId>/register {assetId}
    │       │     → akashic が title / description / canonicalDate / 出典 / メンバー / サムネイル
    │       ├ Discord webhook (🌟 坂井新奈あり + キャプション + TikTok URL + akashic リンク、mp4 ≤ 8MiB は添付)
    │       └ POST /api/v1/tiktok/videos/<videoId>/notified
    │         (失敗は POST .../failed。3 回で止まる)
    └ POST /api/v1/jobs/bot.tiktok_watch/runs           1 周ごとのハートビート (/status に出る)
```

## 2. なぜ台帳を akashic に置くか

insta-watch は bot のローカル state で「既知の投稿」を持ち、akashic には登録結果だけ送る。TikTok では台帳を akashic 側（`TiktokVideo`）に置いた。

- bot の state を失っても（サーバ移設・ディスク障害）、直近 1 ページ分を二重 DL・二重通知しない
- 画面（`/admin/tiktok`）に「どの動画が入ったか / 失敗したか / 未取得が何本か」を出せる
- 初回接触の扱い（過去分を落とさない）と backfill を akashic の 1 箇所で決められる。bot は「見えたものを送り、返ってきたものを取る」だけ

代償: akashic が落ちている間は DL もしない（報告できないので）。登録先が落ちているのだから同じことで、次の周で拾う。

## 3. 検知の方式（実機検証 2026-09-22）

| 方式 | 結果 |
|---|---|
| yt-dlp `https://www.tiktok.com/@hinatazakanews` | ✗ 「Unable to extract secondary user ID」。このアカウントは embed 無効で、yt-dlp の user 抽出が頼る embed ページが使えない |
| yt-dlp `tiktokuser:<secUid>` | ✗ `item_list` が空応答（ブラウザ署名なしでは弾かれる） |
| 素の `curl` で profile | ✗ WAF のチャレンジページ（`slardar`）が返る |
| Playwright headless chromium（`--disable-blink-features=AutomationControlled`） | **✓** `item_list` JSON（48 本・secUid・videoCount）が取れる |
| yt-dlp で単体動画 | **✓** 1080×1920 mp4、キャプション・投稿時刻も取れる |

よって **一覧は Playwright、DL は yt-dlp** の二本立て。Playwright は 1 周に 1 ページ開くだけなので `sekai`（7.6GB RAM）で問題ない。

## 4. データモデル（2 つとも保護テーブル、既定 `internal`）

| テーブル | 役割 | 要点 |
|---|---|---|
| `TiktokWatchTarget` | 監視対象 | `handle`（unique・小文字）/ `sourceName`（出典エンティティ名。空なら `TikTok @handle`）/ `official`（trustLevel を official にするか）/ `intervalMinutes`（既定 30）/ `enabled` / `note`。bot が報告する `secUid` / `videoCount` / `lastCheckedAt` / `lastError` |
| `TiktokVideo` | 見えた動画 1 本 = 1 行 | `videoId`（unique）/ `createTime` / `caption` / `coverUrl` / `status` / `notify`（登録できたら Discord に流すか。新着だけ true）/ `attempts` / `lastError` / `assetId`（unique、登録済みなら）/ `notifiedAt` |

`status` の遷移:

```
(初回接触で見えた)  skipped_initial ──backfill / 画面「取り込む」──▶ pending
(以降の新着)        pending ──register──▶ registered
                    pending ──failed──▶ failed ──(attempts < 3 なら次の周で再び pending 扱い)──▶ …
                    failed (attempts ≥ 3) ──画面「再試行」──▶ pending
```

`notify` は行が生まれたときに決まる: 新着として見つけた行は true、初回接触で飛ばした行は false。**backfill や画面の「取り込む」で pending に戻しても false のまま**（過去分で通知を埋めない）。bot は自分が backfill かどうかではなく、`pending` の応答に載る `notify` に従う。daemon が backfill 中の pending を拾って手伝っても、通知は出ない。

失敗は `attempts < 3` かつ**前回の失敗から 15 分**経ったものだけ次の周に返す（backfill が pending を連続で引くとき、同じ失敗を数分で 3 回使い切らない）。

画面も bot も `withClearance`（bot は API キーのクリアランス）。`prismaInternal` で回す経路は無い。**bot の API キーはクリアランス internal 以上が要る**（両テーブルの既定が internal。低いと対象一覧が無言で空になる）。

## 5. 登録内容（`registerTiktokVideo`）

bot は `POST /upload` で mp4 をアセットにするだけ。中身は akashic が付ける（名簿は akashic だけが持つので）。

| 項目 | 値 |
|---|---|
| `title` | キャプション 1 行目からハッシュタグを除いて 80 字。何も残らなければ `@handle YYYY/MM/DD`（JST） |
| `description` | キャプション全文 |
| `canonicalDate` | 投稿時刻（`createTime`） |
| `sourceType` / `trustLevel` | `web` / 対象が公式なら `official` |
| `SourceRecord` | `sourceKind: url`, `publisher: "TikTok"`, 動画 URL（同じ URL が既にあれば足さない） |
| エンティティ | 出典 `source`（`sourceName`）+ キャプションに現れた**名簿のフルネーム**の `person`（`extractMemberNames`。愛称は追わない） |
| サムネイル | `coverUrl`（署名付き・失効する）を登録時に取って R2 へ。取れなければ `pnpm cli:thumbnails --kind=video` が Drive のサムネイルから後で埋める |

**先に台帳の行を `pending` / `failed` → `registered` に取ってから整える**（`updateMany` で取り合う）。daemon と `watch --once` / backfill が同じ動画を同時に持ってきても、整えるのは 1 回、通知も 1 回（取れなかった側は `alreadyRegistered: true` を受けて何もしない）。整える途中で失敗したら行を `failed` に戻す。同じ動画が別のアセットで登録済み、またはそのアセットが別の動画に紐づいている（dedup で同じファイルが返った）ときは 409（再試行しても解決しないので bot は `failed` で残す）。

`coverUrl` は bot が送った URL をサーバが取りに行くので、TikTok の CDN の https に限る（SSRF 対策）。

登録したアセットの `status` は他の bot 取り込みと同じ `inbox`（人が /inbox で見る）。backfill で 1,000 本入れると /inbox がその分増えるので、まとめて organized にするなら backfill の後に /inbox で行う。

## 6. 通知

- bot の `.env` の `DISCORD_WEBHOOK_URL`（TikTok 専用チャンネル。`/status` の障害通知や X 言及とは別）。未設定なら登録だけ行い `notified` は打たない
- 1 動画 1 メッセージ。先頭に 🌟（`highlight` = 坂井新奈がキャプションに居る）、キャプション（300 字まで）、TikTok URL、akashic のアセット URL。mp4 が 8MiB 以下なら添付（Discord でそのまま再生できる）
- backfill や「取り込む」で登録した分は流さない（台帳の `notify` が false。過去分で通知を埋めない）
- 送信に失敗しても登録は成功扱い。`notifiedAt` が null のまま残る（画面で分かる）。再送は bot の次の周ではなく人が判断する（`/mentions` と違って動画は akashic に入っているので、見落としても後から探せる）

## 7. bot（`hnt42-project/tiktok_downloader`）

- uv + Playwright + yt-dlp。CLI `tiktok-watch`: `list <handle>` / `download <url>` / `watch [--once]` / `backfill <handle>` / `status`
- `sekai` の user systemd `tiktok-watch.service`（insta-watch と同居）。`.env`: `AKASHIC_API` / `AKASHIC_API_KEY`（insta-watch と共用、write 権限）/ `DISCORD_WEBHOOK_URL`
- 対象一覧は最後に読めたものを `state/akashic_targets.json` に残す（akashic が落ちていても次の周の間隔計算に使う。ただし報告できない周は DL しない）
- 巡回間隔は対象ごとの `intervalMinutes` に ±20% のジッター。TikTok の WAF は同一 IP からの規則的なアクセスに厳しいので、これより詰めない
- 実体は yt-dlp が選ぶ最良 = **1080p の h265 (bytevc1)**（h264 は 720p までしか無い）。画質を優先する。Discord の添付は h265 を再生できないクライアントがあるが、TikTok の URL も並べてあるので困らない
- yt-dlp は **venv のもの（`yt-dlp[default,curl-cffi]`）** を使う。TikTok は impersonation（curl_cffi）が無いと「Unexpected response from webpage」で落ちる（標準の単体バイナリ 2025.10 で実測）。更新は `uv lock --upgrade-package yt-dlp && uv sync` して再起動
- `backfill <handle>` は profile を最後までスクロールして全ページを `sightings` に `backfill: true` で送り、返った `pending` を DL する。1 回の応答は 20 件なので `pending` が空になるまで繰り返す。Discord には流さない（`notify: false`）。**daemon を止めなくてよい**: 同じ pending を daemon も拾うことがあるが、register の原子性で二重登録・二重通知にはならず、DL が重なる分だけ無駄になる

## 8. `/status` との関係

`bot.tiktok_watch` を `EXPECTED_JOBS` に入れてある。bot が 1 周ごとに `intervalSec`（対象の最短間隔）を申告して報告し、成功が `intervalSec × 3`（下限 15 分）途絶えると `/status` が「途絶」で赤くなり Discord に出る。対象ごとの失敗（profile が開けない）は `TiktokWatchTarget.lastError` に、動画ごとの失敗は `TiktokVideo.lastError` に残り、`/admin/tiktok` で見る。`Job.lastMessage` は件数だけ（非保護テーブルに載るので本文は写さない）。

## 9. 既知の限界・今後

- logged-out の profile で見えるのは直近 1 ページ（30〜50 本）。1 周の間にそれ以上投稿されることは無い
- TikTok が WAF を強めて headless で `item_list` が取れなくなったら、`report` で対象の `lastError` に残り、その周のハートビートは `error` で送る。`/status` は成功が `intervalSec`（30 分）途絶えた時点で赤くなり Discord に出る。次の手は cookie 付きのブラウザプロファイルか、`secUid` + `tiktokuser:` の yt-dlp 抽出
- `/coverage` の DataSource（`source_url` ルール・`publisherPattern: TikTok`）は今回入れていない。登録が回り出してから足す
- 過去 1,100 本の取り込みは `backfill` を人が打つ。Drive の容量（≈ 5〜10GB）と TikTok のレート制限を一気に使うので、時間を選んで流す
