# Instagram story の iPhone ワーカー (#178)

story の実体を **iPhone 上の Shortcuts** に取りに行かせ、Akashic に登録して Discord に流す仕組み。
サーバ側の API 仕様は [docs/api.md](./api.md) の「story ジョブ」、この文書は **なぜこの形か** と **端末側の作り方**。

## なぜ端末を使うのか

story はサーバから自動取得できない。内部 API (`/api/v1/users/web_profile_info`) は VPS・VPN・自宅回線の
いずれからも 429、`/stories/` ページは `accounts/scraping_warning` にリダイレクトされる (2026-09-22 実測)。
検知だけは logged-out で可能なので、insta-watch は「🟢 story出現」までは自動で飛ばせていたが、中身は人が
保存して Discord の通知にリプライで貼っていた (discord-bot の `src/insta_story/`)。story は 24 時間で消えるので
取りこぼしが多い。

RoutineHub の **Instagram Download** (https://routinehub.co/shortcut/7823/ 、v6.5、作者 @gluebyte) は
端末のログイン済み環境で story を落とせる。そこで iPhone をワーカーにする。

## 全体の流れ

```
insta-watch (sekai)                  Akashic (Vercel)                      iPhone
  story 検知 ──POST /insta/jobs──▶ InstaStoryJob (pending)
                                      │ 空いていれば
                                      ├─POST api.pushcut.io/v1/execute──▶ Pushcut Automation Server
                                      │   { shortcut, input: {jobId,url,handle} }    │
                                      │                                               ▼
                                      │◀──POST /insta/jobs/:id/start─────── ラッパー Shortcut
                                      │                                               │ Run Shortcut
                                      │                                               ▼
                                      │                                    Instagram Download (urls)
                                      │                                    = 落とす直前で URL を送って終わる
                                      │◀──POST /insta/media-urls {text, mark}────────┘
                                      │      ├ CDN から実体を取得 (cookie 不要)
                                      │      ├ DASH の映像と音声を結合 (#201)
                                      │      ├ Asset 作成 (inbox)
                                      │      └ ジョブを完了にする (#199)
                                      ├──▶ Discord に実体つきで通知 (H.264 / 720p / 30fps に変換)
                                      └──▶ 次の pending ジョブを Pushcut へ
```

- ジョブの状態: `pending` → `dispatched` (Pushcut に送った) → `processing` (端末が受け取った) → `completed` | `failed`
- **端末は 1 台**なので同時に走るのは 1 件だけ。完了 / 失敗 / 失効のたびに次の pending を送る
- 失効: `dispatched` のまま 10 分 (端末が受け取れなかった)、`processing` で最後の報告から 20 分 (Shortcut が
  途中で止まった)、`pending` のまま 24 時間 (story が消える)。`/api/cron/insta-jobs` (10 分ごと) でも回収し、
  取り残された pending を送り直す
- 登録される Asset: kind は MIME から、`status=inbox`、`sourceType=web`、`canonicalDate` はジョブを作った日 (JST)、
  タグ「日向坂46」+ source「日向坂46 Instagram」+ story URL の SourceRecord。**人物は付けない**
  (公式垢の story が全部落ちてくるので、誰が写っているかは /inbox で人が付ける)
- 重複判定は SHA256 と **同じハンドル + 同じファイル名** の両方 (`-N` の連番は無視)。同じ story を落とし直すと
  ファイル名とサイズが同じでも中身のバイト列が変わるため (2026-09-22 実測)

コードの置き場: 純粋な判定 `src/lib/insta/jobs.ts` (テストあり)、Pushcut 送信 `src/lib/insta/dispatch.ts`
(ここだけ差し替えれば別の届け方にできる)、ffmpeg `src/lib/insta/transcode.ts`、DB `src/lib/domain/insta-jobs.ts`、
API `src/app/api/v1/insta/`。

## この形に落ち着くまでに分かったこと

順に試して全部ダメだった経路。**同じ道を戻らないため**に残す。

1. **端末に実体を落とさせる** (最初の実装)。動くが無人運用にならない。Instagram の CDN はホスト名が変わり
   (固定回線でも `scontent-nrt6-1` / `nrt1-1` / `nrt1-2` の 3 種)、**iOS の許可は「ショートカット × ドメイン」単位**で
   記録される (Apple のドキュメント)。「常に許可」を押しても次のホストでまた聞かれ、そこで Shortcut が止まる。
   Shortcut を入れ替えると許可はリセットされる
2. **Instagram Download に URL を返させる。** 成立しない。Shortcuts の「ショートカットを実行」は
   **入れ子・自己再入をまたいで出力が呼び出し元に戻らない**。この Shortcut はアプリ切り替えのあと自分自身を
   呼び直す構造 (3 箇所、いずれも直後に終了) で、出力点を 4 箇所に置き、自己呼び出し直後の `exit` を
   出力に変えても、ラッパーが受け取るのは常に空だった (2026-09-27〜28 実測)
3. **いまの形**: 内側の Shortcut が **自分でサーバに POST** する。jobId は要らない (端末は 1 台なので
   「いま processing のジョブ」で宛先が決まる)。返り値に依存しないので入れ子の挙動と無関係

実体の取得・結合・登録・完了判断はすべてサーバ側にある。端末がやるのは「URL を送る」だけ。

### 動画は DASH なので結合が要る (#201)

Instagram は動画を **DASH で配る**。横取りした URL からは「**映像だけの mp4** (VP9)」と
「**音声だけの mp4** (HE-AAC)」が別々に落ちてくる (実測: 到着順に映像→音声の繰り返し)。
Instagram Download は a-Shell の ffmpeg で結合しているが、こちらはその手前で URL を取るので自分で結合する。

結合しないと 1 コマが 2 つの壊れたアセットになり、**iPhone では再生できない**
(Android のプレイヤーは音声だけの mp4 でも鳴るので気づきにくい)。サーバは構成を見て到着順に対にし、
再エンコードせずに 1 本にする。相方がいなければ単独で登録し、音声だけのものは `audio/mp4` にする。

Discord に貼るぶんだけ **H.264 / 720p / 固定 30fps** に変換する (VP9 は iOS で再生できない。
story は「静止画 + 音楽」で 1 fps のことがあり、iOS のプレイヤーは可変・極低 fps を嫌う)。

## サーバ側の準備

1. **ワーカー用の API キー** を作る。`insta_worker` だけを持ち、read / write を持たない
   (端末が漏れても他の API は叩けない)。**permission はルートを絞るだけで、RLS の範囲はキーの持ち主の
   クリアランスで決まる**ので、admin の垢ではなく **clearance が `internal` の専用ユーザー** に発行する:

   ```bash
   pnpm cli:keygen <専用ユーザーのメール> "ipad-insta-worker" insta_worker
   ```

   出た `ak_…` を Shortcut に埋める (後述)。`internal` 未満だと Asset を作れない (403)。

2. Vercel の環境変数:

   | 変数 | 値 |
   |---|---|
   | `PUSHCUT_API_KEY` | Pushcut アプリ > Account > API Keys |
   | `PUSHCUT_SHORTCUT_NAME` | 端末に置いたラッパー Shortcut の名前 (例 `Akashic Story Worker`) |
   | `PUSHCUT_SERVER_ID` | 任意。Automation Server が複数あるときに端末名で絞る |
   | `DISCORD_INSTA_WEBHOOK_URL` | 完了を流す Discord の Incoming Webhook (`#instagram`) |
   | `DISCORD_INSTA_MAX_ATTACHMENT_MB` | 任意。添付 1 件の上限 (既定 10 = ブースト無し。Level 2 なら 50) |

   未設定でもジョブは作れる (pending のまま溜まり、`/admin/insta` に警告が出る)。

3. デプロイ後、`/admin/insta` の「story を取りに行かせる」から手動で 1 件送って通しで確かめる。

## 端末側の準備

**iOS 15 以上なら iPhone でも iPad でも同じ。** Pushcut の Automation Server は
**Pushcut が前面に表示されている端末でしか動かない**ので、画面を点けっぱなしにする専用機になる。
普段使う端末ではなく、余っている iPhone を電源につないで使うのがよい。

### 入れるもの

| アプリ | 用途 |
|---|---|
| Instagram | ログインしておく。**Scriptable で使う垢とは別の垢**を推奨 (作者コメント: 同じ垢を両方で使うと警告が出やすい。2026-06 以降 Instagram の自動化検知が強い) |
| Shortcuts | 標準 |
| Scriptable, a-Shell mini | Instagram Download の依存 (どちらも無料)。URL を取るところまでで a-Shell は使わないが、依存として要る |
| Instagram Download (urls) | 改変版 (後述)。RoutineHub の本家は入れなくてよい |
| Pushcut | Automation Server として常駐。**Automation Server は Pushcut Pro が要る** |

Instagram Download 側の設定 (Save to Files の保存先など) は、いまの経路では**使わない**
(落とす前に終わるため)。本家を入れて設定を触る必要はない。

### Pushcut Automation Server

1. Pushcut > Automation Server > **Start Server**。端末の名前が `PUSHCUT_SERVER_ID` になる (1 台なら省略可)。
   Account > API Keys でキーを作り、`PUSHCUT_API_KEY` に入れる
2. **Pushcut を前面に開いたままにする。** 設定 > 画面表示と明るさ > 自動ロック を「なし」にし
   (低電力モードがオンだと「なし」が選べない)、電源に繋ぐ。有機 EL なら明るさ最低・ダークモードに
3. ラッパーの最後に **「App を開く: Pushcut」** を置き、Scriptable に切り替わった後でも戻るようにする
4. つながっているかは Mac から確認できる:
   `curl -s https://api.pushcut.io/v2/servers -H "API-Key: <キー>"` → `"isConnected": true`。
   アプリの表示が「pending」でも、これが true なら届く

Pushcut の仕様で押さえておくこと ([support/automation-server](https://www.pushcut.io/support/automation-server)):

- 要求は **5 分以内に処理されないと Pushcut 側で自動的に失敗**する (akashic の `dispatched` 失効 10 分より短い)
- 無料枠は **1 日 100 リクエスト・10MB**。story のジョブ数なら足りる
- **60 秒を超えて走る Shortcut があると、バックエンドが一時的に「切断」と報告する**ことがある。
  ジョブのたびに一瞬「pending」に見えるのは正常

## Shortcut は 2 つ

### 1. ラッパー「Akashic Story Worker」

名前は `PUSHCUT_SHORTCUT_NAME` と一致させる。Pushcut から次の JSON **文字列**が Shortcut Input に渡る:

```json
{ "jobId": "cmg…", "url": "https://www.instagram.com/stories/hinatazaka46/", "handle": "hinatazaka46" }
```

アクションはこれだけ (`《…》` は前のアクションの出力):

1. **辞書** — `base` = `https://akashic.sekai-nina.com/api/v1/insta/jobs`、`token` = `ak_…` → **変数を設定** `Config`
2. **入力から辞書を取得** — 入力は `ショートカットの入力`
3. **辞書の値を取得** `jobId` → **変数を設定** `jobId`
4. **辞書の値を取得** `url` → **変数を設定** `storyUrl`
5. **URLの内容を取得** — `《base》/《jobId》/start`、POST、ヘッダ `Authorization: Bearer 《token》`、本文 JSON (空)
6. **URL** — `《storyUrl》` (テキストを URL 型にする)
7. **ショートカットを実行** — `Instagram Download (urls)`、入力は手順 6、「実行中に表示」はオフ
8. **App を開く** — `Pushcut`

**`media-urls` も `complete` もラッパーには入れない。** URL の送信は内側の Shortcut がやり、
完了はサーバが判断する。ラッパーの `complete` が内側の POST より先に走ると 0 件で `failed` になる。

Shortcuts に try/catch は無いので、HTTP が失敗するとその場で止まる。サーバ側が 20 分で `failed` にして
次へ進むので、それで十分とする。

### 2. 改変版「Instagram Download (urls)」

本家 v6.5 から次を変えたもの。**署名付きの `.shortcut` を Mac で作って端末に入れる**
(iCloud Drive の `akashic/` に置いてある)。

| 変えたこと | なぜ |
|---|---|
| story の「今の 1 コマ / 全部」メニューを削除 | 設定では消せず、毎回止まる |
| 更新のお知らせメニューを削除 | 新しい版が出ると毎回出る |
| 確認ダイアログ (alert) を 12 個削除 | すべて実行を止める |
| プロフィール / ハイライトの選択、保存先の選択、フォルダ名の入力を削除 | 無人にならない |
| 「毎回きく」設定の分岐 6 つを無効化 (一覧表示 / グリッド / 日付 / VP9 変換 / キャプション / アプリ切替) | 設定が ask のままでも聞かれないように |
| 落とす直前の 4 箇所に **`POST /api/v1/insta/media-urls` + 終了** を挿入 | 実体は落とさず URL だけ送る |

挿入した 4 箇所には `mark` を付けてある (`dl1` / `dl2` / `ashell` / `end`)。どこを通ったかは
サーバ側のジョブの `error` 欄に `media-urls mark=ashell に N 件届きました` として残る
(端末を覗かずに経路を追える)。実機で通るのは `ashell` (= a-Shell の curl コマンド群を渡す経路)。

作り直すときの手順 (Mac):

```bash
# 1. 本家の plist を取る (RoutineHub は curl だと Cloudflare に弾かれるのでブラウザで iCloud リンクを開く)
curl -s https://www.icloud.com/shortcuts/api/records/<iCloud の ID> -o rec.json
# fields.shortcut.value.downloadURL の ${f} をファイル名に置き換えて取得 → bplist

# 2. plistlib で編集 (WFWorkflowActions の配列を触る)。分岐の対応 (mode 0/2) が合っているか、
#    消したアクションの UUID が他から参照されていないかを必ず検証する

# 3. 署名して配る。入力の拡張子が .shortcut でないと通らない
shortcuts sign --mode anyone --input in.shortcut --output "Instagram Download (urls).shortcut"
```

この Mac には端末のショートカットが iCloud 同期で来ており、`shortcuts list` / `shortcuts run` で見える。
ただし `~/Library/Shortcuts/Shortcuts.sqlite` は TCC で読めないので、中身の確認は plist 側で行う。

## 動作確認

### サーバだけ (curl)

write 権限の通常キーでも同じ口を叩ける。端末なしで API とキューの動きを確かめる:

```bash
API=https://akashic.sekai-nina.com/api/v1/insta
H="Authorization: Bearer ak_…"

# 1. ジョブを作る (Pushcut 未設定なら dispatch.ok=false で pending のまま)
curl -s -X POST $API/jobs -H "$H" -H 'Content-Type: application/json' \
  -d '{"url":"https://www.instagram.com/stories/hinatazaka46/"}'

# 2. 端末のふりをする
curl -s -X POST $API/jobs/<JOB>/start -H "$H"
#    URL は text に丸ごと入れてよい (curl のコマンド行でも中の URL を拾う)
curl -s -X POST $API/media-urls -H "$H" -H 'Content-Type: application/json' \
  -d '{"text":"https://scontent-….cdninstagram.com/…jpg","mark":"test"}'
#    → 1 件でも登録できれば status=completed になり、Discord にも流れる

# 3. 見る
curl -s $API/jobs/<JOB> -H "$H"
curl -s "$API/jobs?status=failed&limit=10" -H "$H"
```

### 端末まで通す

1. `/admin/insta` の「story を取りに行かせる」にハンドルを入れて送る
2. 端末で Pushcut がラッパーを起こし、Instagram Download (urls) が走って URL を送る
3. `/admin/insta` の一覧が **完了** になり、ファイルのリンクが並ぶ。`#instagram` に実体つきで届く

### 止まったときの見方

| 症状 | 見るところ |
|---|---|
| `pending` のまま | Pushcut 未設定 (`/admin/insta` に警告) / 前のジョブが走っている / `error` 欄に `送信に失敗: Pushcut 401` (キー違い) `404` (Shortcut 名・サーバ名違い) `502` `504` (端末が Automation Server として繋がっていない) |
| `dispatched` のまま 10 分で失敗 | Pushcut は受けたがラッパーが `start` を叩けていない。端末でラッパーを手で走らせて `start` の応答を見る (401 ならキー、404 なら URL) |
| `processing` で報告が 20 分途絶えて失敗 | 内側の Shortcut が POST まで到達していない。`error` 欄に `media-urls mark=…` が出ていれば届いてはいる |
| `media-urls … に URL が 1 件も入っていませんでした: {…}` | 届いた本文がそのまま記録されるので、それを見て原因を切り分ける (空なら Shortcut 側が URL を渡せていない) |
| `failed`「ファイルが 1 件も届きませんでした」 | `complete` が先に走った (ラッパーから `complete` を外す) か、URL が 1 件も取れなかった |
| `completed` だが Discord に来ない | `DISCORD_INSTA_WEBHOOK_URL` 未設定か送信失敗 (`error` 欄に `Discord 通知に失敗`)。登録はできているので Asset は /inbox にある。動画は変換してから送るので、完了から届くまで 1 本あたり数十秒かかる |
| Discord で iPhone だと再生できない | 結合されていない (映像だけ / 音声だけ) 可能性。Drive の実体を `ffmpeg -i` で見て、ストリームが 1 本しか無ければ #201 の経路を疑う |

## セキュリティ

- 端末に置くのは **`insta_worker` だけのキー**。できるのはジョブの参照 (`GET /insta/jobs/:id`。一覧は不可) と
  報告だけで、他の API は 403 (例外: `GET /insta/targets` `/insta/account` `/ai-status` は有効なキーなら誰でも読める)。
  `ApiKey.expiresAt` で期限も切れる。キーは clearance `internal` の専用ユーザーに発行するので、上位機密には触れない
- ジョブの `url` は `https://www.instagram.com/stories/<handle>/[<id>/]` しか通さない
- **サーバが取りに行く先は `*.cdninstagram.com` / `*.fbcdn.net` の https だけ。** リダイレクトは追わず、
  認証情報つき URL と IP 直打ちは弾く (`parseMediaUrl`)。1 回 30 URL・合計 400MB・1 件 200MB で切る
- `jobId` を推測しても、キー無しでは何もできない。同じ実体の二重登録は SHA256 とファイル名で `duplicate` になる
- Pushcut の API キーはサーバ側の環境変数にだけ置く
