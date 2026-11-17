# 動画の場面と、スマホで編集する素材（#394）

`/video-scenes` → `/video-scenes/:assetId`。元動画を一度通して見て気になる瞬間を残す入口と、事前に拾った場面から見どころに気づく入口を同じ画面に置く。既存の `/clips` は記事の抜粋プールなので、投稿用の画像・動画とは分ける。

## フロー

- 動画アセット詳細から開く。顔パネルの秒数からも、その時刻の元動画を開ける。
- 場面ごとのカードに、切り抜き・表紙・複数のスクショをまとめる。一覧は幅 640 の非公開サムネイルだけを遅延読み込みし、動画は `preload="none"`。
- 暫定で 3 分以下はスクショだけ。長い動画は小さい顔や他の人へのリアクションも落とさず、本人として検出された区間を候補にする。「かわいい」「笑顔」「発言」を意味として理解した判定は行っていない。
- 区間は前 5 秒・後ろ 3 秒を目安に無音へ寄せる。重なる範囲を結合し、長い区間は無音・画面切替で分け、分割点の前後を重ねる。元の画角と、元に音声があれば音声を残す。
- 「元動画の前後を見る」で文脈を確かめる。元動画を見ながら、そのコマのスクショをブラウザで保存することもできる。
- 保存範囲は開始・終了の秒数、または「開始／終了を今の位置に」で指定。1 本 90 秒以内をワーカーへ書き出し依頼し、長い元動画全体をダウンロードしない。画面には秒数・元動画の容量からの概算と、生成後の実容量を分けて表示する。
- 書き出した範囲は共有の依頼として DB に残る。「保存用に準備した動画」の直近 20 件から、スマホで同じページを開いて保存できる。生成済みの候補をそのまま保存することもできる。

90 秒は X の仕様ではなく、スマホで扱いやすくするためのこの機能の暫定上限。最後の細かい編集・投稿はスマホ側で行う。X への投稿機能は持たない。

## データと認可

生成状況の確認は 10 秒ごとに ID と status だけを読み、変化したときに場面・ファイルの情報を取り直す。タブが非表示なら止め、連続確認は 30 分で終了する。その後は「生成状況を更新」で確認する。

`VideoSceneTask` は `analyze` / `export` の生成依頼、`VideoSceneFile` はその依頼に属する画像・動画。汎用 `Asset` に機密のスナップショットを複製しない。両テーブルとも親動画の **現在の classification** で RLS を効かせる。元動画を上位機密に変えると、依頼・生成物も即座に下位の人には見えなくなる。

読み書きは `withClearance`。依頼・ワーカーの操作は admin / member。viewer は閲覧・見える素材の保存だけ。画面の認証・role は Server Action 内でも検査する。

生成物は `VIDEO_SCENES_DRIVE_FOLDER_ID` の専用フォルダへ置く。アップロード時に anyone / domain 公開のフォルダを拒否し、公開権限を作る `finalizeDriveUpload` や公開 R2 は使わない。Drive の appProperties で、依頼・出力ファイル・処理期限のトークンに結びつける。任意の Drive ファイルを登録できない。

配信は認証済み `/api/video-scenes/media/:id`（元動画は `?source=1`）。4 MB ごとの Range、`private, no-store`。画像は 4 MB 以下、動画は 100 MB 以下。保存時も選んだファイルだけを Range でつなぎ、途中のログインページや異なる範囲は保存しない。

ブラウザの配信はセッションと通常の MFA を維持する。Cookie を持たないワーカーの元動画取得は、API キー認証専用の `/api/v1/video-scenes/assets/:assetId/source` を使う。

## ワーカー

`scripts/video-scene-worker.py` を omokage と同じ Python 環境で動かす。必要なのは InsightFace / numpy / OpenCV と ffmpeg / ffprobe。HTTP・推論・エンコードを Web の応答中に行わない。顔認識の参照は `--refs` に NPZ（`ids`, `matrix`）を渡す。参照の更新は omokage 側と同じ運用で行う。

```sh
# キーは環境から注入する。コマンド引数やログに書かない。
# AKASHIC_BASE_URL=https://<akashic のホスト>
# AKASHIC_VIDEO_WORKER_KEY=<専用 member/internal ユーザーの video_scene_worker キー>
python scripts/video-scene-worker.py --refs /path/to/refs-full.npz --max-jobs 1 --discover
```

既定は待っている依頼を 1 件処理して終了。`--discover` を付けると、依頼が無いときに本人の人物タグ・確定した顔を持つ新しい動画を 1 件だけ依頼して処理する。書き出し依頼を先に処理する。無限ループは作らず、必要なら systemd timer 等で繰り返し呼ぶ。元動画 2 GB 以下、1 件の処理は既定 2 時間まで。子プロセスは CPU スレッドを抑え、timeout で終了する。

処理の取得は行ロック + `SKIP LOCKED`。10 分の lease を 45 秒ごとに延長し、期限切れは再取得できる。古いトークンの完了・アップロード・期限延長は拒否する。3 回処理されても期限切れになった依頼は failed にして、人が再試行する。同じ動画の分析、同じ開始・終了（0.1 秒単位）の書き出しは一意キーとトランザクションロックで重複を防ぐ。

作業用の一時ファイルは処理後に削除する。Drive へのアップロード途中でプロセスが失われた場合、未登録の Drive ファイルが残る可能性がある。自動削除は行わず、専用フォルダの appProperties によって対象を下見してから整理する。

元動画を見ながらの範囲指定は、場面候補の分析前でも依頼できる。未分析ならワーカーの ffprobe で実際の長さを確かめ、動画外の範囲は出力しない。`--export-only` は保存用の書き出しだけを処理する。分析中に保存を待たせない運用では、分析用 timer と書き出し専用 timer を分ける。`--export-only` と `--discover` は併用不可。1 依頼の出力はサムネイルを含め最大 1,000 ファイル。

`deploy/video-scenes-*.service` / `.timer` は sekai のユーザーユニット。コードは `~/akashic-video-scenes/scripts`、参照は `data/refs-full.npz`、鍵は `~/.config/akashic-video-scenes/worker.env`（0600）へ配置する。Python は既存の `~/sekai-nina-omokage/.venv` を使う。分析は完了後10分、書き出しは完了後1分ごとに1件。分析 CPU 100% / 1800 MB、書き出し CPU 50% / 512 MB に制限し、既存サービスは変更しない。timer は1件の実地確認後に有効化する。

## 適用順と検証

1. migration `20261116000000_video_scene_tasks` と両テーブルへの GRANT を、承認後に適用する。
2. 認証アカウントだけが読める専用 Drive フォルダを用意し、Web 側に `VIDEO_SCENES_DRIVE_FOLDER_ID` を設定する。
3. Web を反映し、ワーカーに専用 API キー・API URL・参照ファイルを設定する。最初は `--max-jobs 1` で 1 件確かめる。
4. 元動画から範囲を選ぶ → 書き出し → スマホで保存、と、候補から元動画の前後を見る動線を実機で確かめる。その後に timer を有効にする。

この実装時点では **本番 migration・Web 反映・ワーカーの常駐化は未実施**。

- ローカル PostgreSQL: `node scripts/check-video-scenes-rls.mjs`。.env を読まず、ネットワークを持たない一時コンテナを作って終了時に破棄する。8 ポリシー、下位・未設定 clearance、書き込み拒否、親の再分類、保存範囲の制約を検証する。
- TypeScript: `pnpm typecheck` / `pnpm test`。認可・期限切れ・他の依頼の生成物の拒否・Range / 保存・画面の SSR を含む。
- オフラインの生成検証: `video-scene-worker.py render --source <動画> --out <一時フォルダ> --kind analyze --frames <保存済みの frames.json>`。`--kind export --start 5 --end 12` は指定範囲だけの動画を作る。
- ブラウザと実機の操作、稼働中ワーカーを通す検証は本番未反映のため未実施。
