# Instagram story の iPad ワーカー (#178)

story の実体を **iPad 上の Shortcuts** に取りに行かせ、Akashic に登録して Discord に流す仕組み。
サーバ側の仕様は [docs/api.md](./api.md) の「story ジョブ」、この文書は **なぜこの形か** と **iPad 側の作り方**。

## なぜ iPad か

story はサーバから自動取得できない。内部 API (`/api/v1/users/web_profile_info`) は VPS・VPN・自宅回線の
いずれからも 429、`/stories/` ページは `accounts/scraping_warning` にリダイレクトされる (2026-09-22 実測)。
検知だけは logged-out で可能なので、insta-watch は「🟢 story出現」までは自動で飛ばせていたが、中身は人が
保存して Discord の通知にリプライで貼っていた (discord-bot の `src/insta_story/`)。story は 24 時間で消えるので
取りこぼしが多い。

RoutineHub の **Instagram Download** (https://routinehub.co/shortcut/7823/ 、v6.5、作者 @gluebyte) は
iPad 上のログイン済み環境で story を落とせる。そこで iPad をワーカーにする。

## 全体の流れ

```
insta-watch (sekai)                         Akashic (Vercel)                       iPad
  story 検知 ──POST /api/v1/insta/jobs──▶ InstaStoryJob (pending)
                                            │ 空いていれば
                                            ├─POST api.pushcut.io/v1/execute──▶ Pushcut Automation Server
                                            │   { shortcut, input: {jobId,url,handle} }   │
                                            │                                              ▼
                                            │◀──POST /jobs/:id/start────────── ラッパー Shortcut
                                            │                                              │ Run Shortcut
                                            │                                              ▼
                                            │                                     Instagram Download
                                            │                                     (Files に保存)
                                            │◀──POST /jobs/:id/upload-url────────────────┘
                                            │──▶ { uploadUrl }
                                            │        iPad ──PUT file──▶ Google Drive
                                            │◀──POST /jobs/:id/result {driveFileId}  (ファイルごと)
                                            │      Asset 作成 (inbox)
                                            │◀──POST /jobs/:id/complete
                                            ├──▶ Discord (DISCORD_INSTA_WEBHOOK_URL) に実体つきで 1 通
                                            └──▶ 次の pending ジョブを Pushcut へ
```

- ジョブの状態: `pending` → `dispatched` (Pushcut に送った) → `processing` (iPad が受け取った) → `completed` | `failed`
- **iPad は 1 台**なので同時に走るのは 1 件だけ。complete / error / 失効のたびに次の pending を送る
- 失効: `dispatched` のまま 10 分 (iPad が受け取れなかった)、`processing` のまま 20 分 (Shortcut が途中で止まった)、
  `pending` のまま 24 時間 (story が消える)。`/api/cron/insta-jobs` (10 分ごと) でも回収し、取り残された pending を送り直す
- 動画は Vercel の本文上限 (4.5MB) を超えるので、**iPad が Google Drive に直接 PUT** する
  (`upload-url` → PUT → `result`)。4MB 以下なら `result` に multipart で直接送ってもよい
- 登録される Asset: kind は MIME から、`status=inbox`、`sourceType=web`、`canonicalDate` はジョブを作った日 (JST)、
  タグ「日向坂46」+ source「日向坂46 Instagram」+ story URL の SourceRecord。**人物は付けない**
  (公式垢の story が全部落ちてくるので、誰が写っているかは /inbox で人が付ける)
- 同じ実体が既にあれば (SHA256) 新しい Asset は作らず `duplicate` として記録し、Discord には添付しない
  (「更新」で同じコマがもう一度落ちてきても二重登録にならない。同じ `driveFileId` を再送しても原本は消えない)

コードの置き場: 純粋な判定 `src/lib/insta/jobs.ts` (テストあり)、Pushcut 送信 `src/lib/insta/dispatch.ts`
(ここだけ差し替えれば別の届け方にできる)、DB `src/lib/domain/insta-jobs.ts`、API `src/app/api/v1/insta/jobs/`。

## サーバ側の準備

1. **ワーカー用の API キー** を作る。`insta_worker` だけを持ち、read / write を持たない
   (iPad が漏れても他の API は叩けない。ジョブの参照と報告だけできる)。
   **permission はルートを絞るだけで、RLS の範囲はキーの持ち主のクリアランスで決まる**ので、
   admin の垢ではなく **clearance が `internal` の専用ユーザー** (例: `ipad-worker@…` を招待して internal にする) に発行する:

   ```bash
   pnpm cli:keygen <専用ユーザーのメール> "ipad-insta-worker" insta_worker
   ```

   出た `ak_…` を iPad の Shortcut に貼る (後述)。`internal` 未満だと Asset を作れない (403)。

2. **Pushcut** の API キーを取り、Vercel の環境変数に入れる:

   | 変数 | 値 |
   |---|---|
   | `PUSHCUT_API_KEY` | Pushcut アプリ > Account > API Keys |
   | `PUSHCUT_SHORTCUT_NAME` | iPad に置いたラッパー Shortcut の名前 (例 `Akashic Story Worker`) |
   | `PUSHCUT_SERVER_ID` | 任意。Automation Server が複数あるときに端末名で絞る |
   | `DISCORD_INSTA_WEBHOOK_URL` | 完了を流す Discord の Incoming Webhook (`#instagram`) |

   未設定でもジョブは作れる (pending のまま溜まり、`/admin/insta` に警告が出る)。

3. デプロイ後、`/admin/insta` の「story を iPad に取りに行かせる」から手動で 1 件送って通しで確かめる。

## iPad 側の準備

「iPad」と書いているが **iOS 15 以上なら iPhone でも同じ** (設計に iPad 固有のものは無い)。
Pushcut の Automation Server は **Pushcut が前面に表示されている端末でしか動かない**ので、画面を点けっぱなしにする
専用機になる。普段使う端末ではなく、余っている iPhone を電源につないで使うのがよい。

### 入れるもの

| アプリ | 用途 |
|---|---|
| Instagram | ログインしておく。**Scriptable で使う垢とは別の垢**を推奨 (作者コメント: 同じ垢を両方で使うと警告が出やすい。2026-06 以降 Instagram の自動化検知が強くなっている) |
| Shortcuts | 標準 |
| Scriptable, a-Shell mini | Instagram Download の依存 (どちらも無料) |
| Instagram Download (RoutineHub 7823) | 本体。RoutineHub の「Get Shortcut」から入れる |
| Pushcut | Automation Server として常駐させる。**Automation Server はサブスクリプション (Pushcut Pro) が要る** |

### Instagram Download の設定

Shortcuts アプリから Instagram Download を直接実行すると設定画面が出る。以下にする:

- **Save to Files: オン**、保存先フォルダを固定する。ラッパーはこのフォルダの **差分**で落としたファイルを
  見つけるので、Photos 保存ではなく Files 保存にする
- 保存先は **「このiPhone内」(On My iPhone) にフォルダを作って選ぶ** (例 `Instagram Download`)。iCloud Drive だと
  story の実体が Apple のサーバに同期され (容量も食う)、同期のタイミングで Shortcut から「まだ無い」ように
  見えることがある。ローカルなら保存した瞬間に見え、片付けも端末内で終わる
- 動画の形式は H.264 か HEVC (VP9 のままだと Photos に保存できず Files に落ちる。Akashic 側は mp4 / mov コンテナなら
  中身が VP9 でも受けるが、`.webm` は受けない)
- 一度、共有シートから手で story を落として、フォルダにファイルが出ることを確かめておく

### Pushcut Automation Server

1. Pushcut > Automation Server > **Start Server**。端末の名前 (例 `Nao's iPad`) が `PUSHCUT_SERVER_ID` になる
   (端末が 1 台なら省略可)。Account > API Keys でキーを作り、`PUSHCUT_API_KEY` に入れる
2. **Pushcut を前面に開いたままにする。** Automation Server は Pushcut が前面にいる間だけ Shortcut を実行できる。
   設定 > 画面表示と明るさ > 自動ロック を「なし」にし (低電力モードがオンだと「なし」が選べない)、電源に繋いでおく。
   有機 EL なら明るさを最低にし、ダークモードにしておく
3. ラッパー Shortcut の最後に **「App を開く: Pushcut」** を置いて、Instagram Download が Scriptable / a-Shell に
   切り替えた後でも Pushcut に戻るようにする (後述の手順 14)
4. つながっているかは Mac から `curl -s https://api.pushcut.io/v2/servers -H "API-Key: <キー>"` で見る
   (`"isConnected": true`)。アプリ側の表示が「pending」でも、これが true なら届く

Pushcut の仕様で押さえておくこと ([support/automation-server](https://www.pushcut.io/support/automation-server)):

- 要求は **5 分以内に処理されないと Pushcut 側で自動的に失敗**する (akashic の `dispatched` 失効 10 分より短いので、
  iPad が不在なら先に Pushcut が落とし、akashic は 10 分で failed にして次へ進む)
- 無料枠は **1 日 100 リクエスト・10MB**。story のジョブ数なら足りる
- **60 秒を超えて走る Shortcut があると、バックエンドが一時的に「切断」と報告する**ことがある。ラッパーは動画があると
  数分走るので、ジョブのたびに一瞬「pending」に見えるのは正常。次の要求は復帰後に届く

## ラッパー Shortcut の作り方

名前は `PUSHCUT_SHORTCUT_NAME` と同じにする (例 `Akashic Story Worker`)。**Instagram Download 自体は改造しない。**

Shortcut Input として Pushcut から次の JSON **文字列** が渡る:

```json
{ "jobId": "cmg…", "url": "https://www.instagram.com/stories/hinatazaka46/", "handle": "hinatazaka46" }
```

以下、アクションごとに書く。`《…》` は前のアクションの出力 (マジック変数)。Shortcuts に try/catch は無いので、
HTTP が失敗すると **その場で Shortcut が止まる** — サーバ側は 20 分で `failed` にするので、それで十分とする。

### 0. 設定値

1. **辞書** — 名前 `Config`。以下のキーを入れる
   - `base` = `https://akashic.sekai-nina.com/api/v1/insta/jobs`
   - `token` = `ak_…` (ワーカー用キー)
   - (保存先フォルダは文字で持たない。手順 9 でフォルダピッカーから直接選ぶ)

### 1. 入力を読む

2. **入力から辞書を取得** — 入力: `Shortcut Input`
   (Pushcut の `input` は文字列なので、このアクションで JSON として解釈する)
3. **辞書の値を取得** — `jobId` を `《辞書》` から → 変数 `jobId` に設定
4. **辞書の値を取得** — `url` を `《辞書》` から → 変数 `storyUrl` に設定

### 2. 受け取ったことを報告 (→ processing)

5. **URL の内容を取得**
   - URL: `《Config.base》/《jobId》/start`
   - 方法: POST
   - ヘッダ: `Authorization` = `Bearer 《Config.token》`
   - 本文: JSON (空でよい)

### 3. 開始時刻を控える

6. **現在の日付** → 変数 `startedAt` に設定
   (Instagram Download が出力を返さない前提で、保存先フォルダの **この時刻より後に更新されたファイル** を拾う)

### 4. Instagram Download を実行

7. **URL** — `《storyUrl》` (テキストを URL 型にする。共有シートから渡るのと同じ型にするため)
8. **ショートカットを実行** — `Instagram Download`、入力: `《URL》`、「実行中に表示」はオフ

   > **断定できないこと (要実機確認):**
   > - Instagram Download が **Shortcut Input として URL を受け取れるか。** RoutineHub の説明では共有シート
   >   (Instagram アプリ / Safari) からの実行が前提で、「ショートカットを実行」経由の入力は明記されていない。
   >   共有シートも中身は URL なので通る見込みだが、動かなければ下の「代替案」へ
   > - `https://www.instagram.com/stories/<handle>/` (story ID 無し) で **その垢の現在の story 全コマ** を落とすか。
   >   insta-watch は検知時にハンドルしか持たない (story ID は取れない) ので、この形で渡す。動かなければ
   >   Instagram Download の「Open Instagram in Scriptable」モードで垢のページを開き、⏹️ ボタン相当の一括保存を
   >   使う運用 (手動) に落ちる
   > - **出力を返すか。** 説明では Files / Photos に保存して Scriptable のブラウザに戻る。返さない前提で
   >   フォルダの差分を使う (手順 9〜10)。返すなら手順 9〜10 を `《ショートカットの結果》` に置き換えられる

### 5. 落ちたファイルを見つける

9. **フォルダの内容を取得** — フォルダは **ピッカーで「このiPhone内 > (Instagram Download の保存先)」を選ぶ**。
   「再帰的」はオン。文字でパスを書くと iCloud Drive の `Shortcuts/` 配下として解釈され、ローカルのフォルダには届かない
10. **ファイルにフィルタを適用** — 条件: `最終更新日` が `《startedAt》` **より後**。並び順: 最終更新日
11. **カウント** — `《フィルタ済みファイル》` の項目数 → 変数 `count`
    - **if** `count` が 0 → **URL の内容を取得** POST `《Config.base》/《jobId》/error`、
      本文 JSON `{ "error": "Instagram Download が何も保存しなかった" }` → **ショートカットを停止**

### 6. ファイルごとにアップロード

12. **各項目を繰り返す** — `《フィルタ済みファイル》`。中で:

    a. **ファイルの詳細を取得** — `名前` → 変数 `filename`、`ファイルサイズ` → 変数 `size` (バイト。
       「ファイルサイズ」は単位付き文字列で返ることがあるので、その場合は送らなくてよい)

    b. **URL の内容を取得** — POST `《Config.base》/《jobId》/upload-url`
       - ヘッダ: `Authorization` = `Bearer 《Config.token》`
       - 本文 JSON: `filename` = `《filename》`、`mimeType` = (空でよい。サーバが拡張子から補う)
       - 応答は `{ "uploadUrl": "…", "mimeType": "video/mp4" }`

    c. **辞書の値を取得** — `uploadUrl` → 変数 `uploadUrl`、`mimeType` → 変数 `mimeType`

    d. **URL の内容を取得** — **PUT** `《uploadUrl》`
       - ヘッダ: `Content-Type` = `《mimeType》` (Drive 側の MIME を正しくする。動画のサムネイル生成に効く)
       - 本文: **ファイル** = `《繰り返し項目》`
       - Authorization ヘッダは **付けない** (Drive のセッション URL で守られている)
       - 応答は Drive の `{ "id": "1AbC…", "name": "…" }`

    e. **辞書の値を取得** — `id` → 変数 `driveFileId`

    f. **URL の内容を取得** — POST `《Config.base》/《jobId》/result`
       - ヘッダ: `Authorization` = `Bearer 《Config.token》`
       - 本文 JSON: `driveFileId` = `《driveFileId》`、`filename` = `《filename》`、`mimeType` = `《mimeType》`
       - 応答 201。同じ実体が既にあれば `file.duplicate = true` で返る (エラーではない)

    > 4MB 以下の画像だけなら b〜e を飛ばして、f を multipart (本文: フォーム、`file` = `《繰り返し項目》`) にしてもよい。
    > 動画はほぼ 4MB を超えるので、迷ったら全部 Drive 経路にする

### 7. 完了

13. **URL の内容を取得** — POST `《Config.base》/《jobId》/complete`、ヘッダ `Authorization`、本文 JSON (空)
    - サーバが Discord に流し、次の pending ジョブを送る
14. **App を開く** — `Pushcut` (Automation Server に戻す)

### 落としたファイルの片付け

Instagram Download の保存先に実体が溜まる。手順 12 の最後に **「ファイルを削除」** `《繰り返し項目》` を入れると
片付くが、`result` が失敗したとき (413 / 415 / 502) に実体まで消えて再送できなくなる。まずは残す運用にし、
月に一度フォルダを空にする。

## 代替案 (Instagram Download が URL 入力で動かない / 出力を返さないとき)

第一案は上の「URL を Shortcut Input として渡す」方式。動かなかった順に:

1. **フォルダ差分 (上の手順そのもの)。** 出力を返さなくても、Files に保存さえされれば拾える。これが既定
2. **Instagram Download を複製して末尾で返す。** RoutineHub から入れた Shortcut を複製し、最後の「ファイルを保存」の
   直後に **「ショートカットを停止して出力」** `《保存したファイル》` を足す。ラッパーは手順 9〜11 を
   `《ショートカットの結果》` に置き換える。複製は本家の更新に追従しないので、動かなくなったら差分方式に戻す
3. **Scriptable モード。** Instagram Download を Shortcuts から起動し「Open Instagram in Scriptable」で垢の
   ページを開き、⏹️ ボタンで現在の story を一括保存する。自動化はできない (人が押す) が、共有シートを経ないので
   Instagram アプリ側の検知に触れにくい (作者コメント)
4. **Instagram アプリの共有シートを UI 操作で自動化する** のは最終手段で、**今回はやらない** (検知の対象になる)

## 動作確認

### サーバだけ (curl)

write 権限の通常キーでも同じ口を叩ける。iPad 無しで API とキューの動きを確かめる:

```bash
API=https://akashic.sekai-nina.com/api/v1/insta/jobs
H="Authorization: Bearer ak_…"

# 1. 作る (Pushcut 未設定なら dispatch.ok=false で pending のまま)
curl -s -X POST $API -H "$H" -H 'Content-Type: application/json' \
  -d '{"url":"https://www.instagram.com/stories/hinatazaka46/"}'
# → {"id":"<JOB>", "status":"pending"|"dispatched", …}

# 2. iPad のふりをする
curl -s -X POST $API/<JOB>/start -H "$H"
curl -s -X POST $API/<JOB>/result -H "$H" -F file=@/path/to/story.jpg         # 4MB 以下
curl -s -X POST $API/<JOB>/complete -H "$H"
# → status: completed, notified: true (DISCORD_INSTA_WEBHOOK_URL があれば Discord に届く)

# 3. 見る
curl -s $API/<JOB> -H "$H"
curl -s "$API?status=failed&limit=10" -H "$H"
```

動画 (4MB 超) の経路:

```bash
curl -s -X POST $API/<JOB>/upload-url -H "$H" -H 'Content-Type: application/json' \
  -d '{"filename":"story.mp4","mimeType":"video/mp4"}'
# → {"uploadUrl":"https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=…"}
curl -s -X PUT "<uploadUrl>" -H 'Content-Type: video/mp4' --data-binary @story.mp4
# → {"id":"<DRIVE_ID>", …}
curl -s -X POST $API/<JOB>/result -H "$H" -H 'Content-Type: application/json' \
  -d '{"driveFileId":"<DRIVE_ID>","filename":"story.mp4","mimeType":"video/mp4"}'
```

### iPad まで通す

1. `/admin/insta` の「story を iPad に取りに行かせる」にハンドルを入れて送る
2. iPad で Pushcut がラッパー Shortcut を起こし、Instagram Download が動く
3. `/admin/insta` の一覧で `完了` になり、ファイルのリンクが並ぶ。Discord に実体つきで届く

### 状態が進まないとき

| 症状 | 見るところ |
|---|---|
| `pending` のまま | Pushcut 未設定 (`/admin/insta` に警告) / 前のジョブが `dispatched` `processing` のまま (失効を待つか「キューを進める」) / `error` 欄に `送信に失敗: Pushcut 401` (キー違い) `404` (Shortcut 名・サーバ名違い) `502` `504` (iPad が Automation Server として繋がっていない) |
| `dispatched` のまま 10 分で失敗 | Pushcut は受けたが Shortcut が start を叩けていない。iPad で Shortcut を手で走らせて `start` の応答を見る (401 ならキー、404 なら URL) |
| `processing` のまま 20 分で失敗 | Shortcut が途中で止まった。iPad の Shortcuts アプリに残るエラーを見る。`415` は拡張子が画像・動画でない、`413` は multipart に 4MB 超を送った、`502` は Drive から読めない (PUT が完了していない) |
| `failed`「ファイルが 1 件も届きませんでした」 | Instagram Download が何も保存しなかったか、フォルダ / 時刻のフィルタが合っていない。保存先フォルダの設定と手順 9〜10 を見直す |
| `completed` だが Discord に来ない | `DISCORD_INSTA_WEBHOOK_URL` 未設定 (`notified: false`) か送信失敗 (`error` 欄に `Discord 通知に失敗`)。登録はできているので Asset は /inbox にある |

## セキュリティ

- iPad に置くのは **`insta_worker` だけのキー**。漏れてもできるのはジョブの参照 (`GET /insta/jobs/:id`。一覧は不可) と
  報告 (start / upload-url / result / complete / error) だけで、他の API は 403 (例外: `GET /insta/targets` `/insta/account`
  `/ai-status` は有効なキーなら誰でも読める設計)。`ApiKey.expiresAt` で期限も切れる。キーは clearance `internal` の
  専用ユーザーに発行するので、上位機密の Asset には触れない
- ジョブの `url` は `https://www.instagram.com/stories/<handle>/[<id>/]` しか通さない。iPad に任意の URL を開かせる口にしない
- サーバは story の URL を **一切 fetch しない** (SSRF の口が無い)。サーバが外に出るのは Pushcut・Drive・Discord だけで、
  宛先はすべて固定
- 受け取るファイルは MIME (拡張子) を画像・動画に限り、multipart は 4MB、Drive 経路は 200MB で切る。
  ファイル名はパス区切りと制御文字を落として 120 字に詰める
- `jobId` を推測しても、キー無しでは何もできない。同じジョブへの二重アップロードは SHA256 で `duplicate` になり
  Asset は増えない。`driveFileId` に既存 Asset の実体を指定されても、参照されている実体は消さない
- Pushcut の API キーはサーバ側の環境変数にだけ置く。iPad から Akashic を叩く経路にも Pushcut のキーは不要
