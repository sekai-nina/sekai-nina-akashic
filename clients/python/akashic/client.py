"""Akashic REST API v1 Python client."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import requests


class AkashicError(Exception):
    """API error with status code and message."""

    def __init__(self, status: int, body: Any):
        self.status = status
        self.body = body
        msg = body.get("error", body) if isinstance(body, dict) else body
        super().__init__(f"HTTP {status}: {msg}")


class AkashicClient:
    """Akashic REST API v1 クライアント.

    Usage::

        from akashic import AkashicClient

        client = AkashicClient("http://localhost:3000", "ak_xxxxx")

        # アセット一覧
        result = client.list_assets(kind="image", page=1)

        # アセット作成
        asset = client.create_asset(
            kind="text",
            title="ブログ記事",
            source_type="web",
            texts=[{"textType": "body", "content": "本文..."}],
            source_records=[{"sourceKind": "url", "url": "https://..."}],
        )

        # ファイルアップロード
        asset = client.upload("photo.jpg")

        # 検索
        results = client.search("坂井新奈", kind="image")

        # ミーグリを作って X レポを集める
        mg = client.create_meetgreet("2026-08-01", "real", single="17th…", label="京都")
        client.fetch_meetgreet_reports(mg["id"])
    """

    def __init__(self, base_url: str, api_key: str, *, timeout: int = 30):
        self.base_url = base_url.rstrip("/")
        self._api_url = f"{self.base_url}/api/v1"
        self._session = requests.Session()
        self._session.headers["Authorization"] = f"Bearer {api_key}"
        self._timeout = timeout

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        files: dict[str, Any] | None = None,
        timeout: int | None = None,
        with_status: bool = False,
    ) -> Any:
        url = f"{self._api_url}{path}"
        # params から None の値を除去
        if params:
            params = {k: v for k, v in params.items() if v is not None}

        resp = self._session.request(
            method,
            url,
            json=json,
            params=params,
            data=data,
            files=files,
            timeout=timeout if timeout is not None else self._timeout,
        )
        body = resp.json() if resp.content else None
        if resp.status_code >= 400:
            raise AkashicError(resp.status_code, body)
        return (body, resp.status_code) if with_status else body

    # ------------------------------------------------------------------
    # Assets
    # ------------------------------------------------------------------

    def list_assets(
        self,
        *,
        status: str | None = None,
        kind: str | None = None,
        trust_level: str | None = None,
        source_type: str | None = None,
        page: int = 1,
        per_page: int = 20,
    ) -> dict[str, Any]:
        """アセット一覧を取得する。

        Returns:
            {"items": [...], "total": int}
        """
        return self._request(
            "GET",
            "/assets",
            params={
                "status": status,
                "kind": kind,
                "trustLevel": trust_level,
                "sourceType": source_type,
                "page": page,
                "perPage": per_page,
            },
        )

    def get_asset(self, asset_id: str) -> dict[str, Any]:
        """アセットの詳細を取得する（リレーション含む）。"""
        return self._request("GET", f"/assets/{asset_id}")

    def create_asset(
        self,
        kind: str,
        *,
        title: str = "",
        description: str = "",
        status: str | None = None,
        trust_level: str | None = None,
        source_type: str | None = None,
        canonical_date: str | None = None,
        storage_provider: str | None = None,
        storage_url: str | None = None,
        thumbnail_url: str | None = None,
        texts: list[dict[str, Any]] | None = None,
        entities: list[dict[str, Any]] | None = None,
        source_records: list[dict[str, Any]] | None = None,
        **extra: Any,
    ) -> dict[str, Any]:
        """アセットを作成する。

        Args:
            kind: "image", "video", "audio", "text", "document", "other"
            texts: [{"textType": "body", "content": "..."}, ...]
            entities: [{"entityId": "...", "roleLabel": "..."}, ...]
            source_records: [{"sourceKind": "url", "url": "...", ...}, ...]
        """
        body: dict[str, Any] = {"kind": kind, **extra}
        if title:
            body["title"] = title
        if description:
            body["description"] = description
        if status:
            body["status"] = status
        if trust_level:
            body["trustLevel"] = trust_level
        if source_type:
            body["sourceType"] = source_type
        if canonical_date:
            body["canonicalDate"] = canonical_date
        if storage_provider:
            body["storageProvider"] = storage_provider
        if storage_url:
            body["storageUrl"] = storage_url
        if thumbnail_url:
            body["thumbnailUrl"] = thumbnail_url
        if texts:
            body["texts"] = texts
        if entities:
            body["entities"] = entities
        if source_records:
            body["sourceRecords"] = source_records
        return self._request("POST", "/assets", json=body)

    def update_asset(
        self,
        asset_id: str,
        *,
        entities: list[dict[str, Any]] | None = None,
        source_records: list[dict[str, Any]] | None = None,
        **fields: Any,
    ) -> dict[str, Any]:
        """アセットを部分更新する。

        キーワード引数でフィールドを指定する。snake_case は camelCase に変換される。
        entities と source_records はリレーションの追加・更新ができる。

        Example::

            client.update_asset(
                id,
                status="organized",
                trust_level="high",
                entities=[{"entityId": "cm_xxx", "roleLabel": "author"}],
                source_records=[{
                    "sourceKind": "url",
                    "url": "https://example.com/blog/1",
                    "title": "ブログタイトル",
                    "publisher": "Ameba",
                }],
            )
        """
        # snake_case → camelCase 変換
        camel_map = {
            "trust_level": "trustLevel",
            "source_type": "sourceType",
            "canonical_date": "canonicalDate",
            "storage_provider": "storageProvider",
            "storage_url": "storageUrl",
            "storage_key": "storageKey",
            "thumbnail_url": "thumbnailUrl",
            "original_filename": "originalFilename",
            "mime_type": "mimeType",
            "file_size": "fileSize",
            "message_body_preview": "messageBodyPreview",
            "discord_guild_id": "discordGuildId",
            "discord_channel_id": "discordChannelId",
            "discord_message_id": "discordMessageId",
            "discord_message_url": "discordMessageUrl",
            "discord_author_id": "discordAuthorId",
            "discord_author_name": "discordAuthorName",
            "discord_posted_at": "discordPostedAt",
        }
        body: dict[str, Any] = {}
        for k, v in fields.items():
            body[camel_map.get(k, k)] = v
        if entities is not None:
            body["entities"] = entities
        if source_records is not None:
            body["sourceRecords"] = source_records
        return self._request("PATCH", f"/assets/{asset_id}", json=body)

    def set_nina_appearance(self, asset_id: str, status: str) -> dict[str, Any]:
        """坂井新奈が出ているかを置く (#261)。Discord の ✅ / ❌ 用。

        Args:
            status: "appears" (出ている) / "absent" (確認して出ていない) / "unchecked" (未確認に戻す)

        Returns:
            {"id": str, "ninaAppearance": str}

        坂井新奈が著者 (author) のアセットを absent / unchecked にすると 409 (AkashicError)。
        """
        return self._request(
            "PUT", f"/assets/{asset_id}/nina-appearance", json={"status": status}
        )

    def delete_asset(self, asset_id: str) -> dict[str, Any]:
        """アセットを削除する。"""
        return self._request("DELETE", f"/assets/{asset_id}")

    # ------------------------------------------------------------------
    # Search
    # ------------------------------------------------------------------

    def search(
        self,
        q: str,
        *,
        target: str | None = None,
        kind: str | None = None,
        status: str | None = None,
        trust_level: str | None = None,
        source_type: str | None = None,
        entity_id: str | None = None,
        entity_ids: list[str] | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        nina_appearance: str | None = None,
        page: int = 1,
        per_page: int = 20,
    ) -> dict[str, Any]:
        """全文検索。

        nina_appearance ("appears" / "absent" / "unchecked") で坂井新奈の出演を絞れる。

        entity_ids を複数指定すると AND 検索になる。

        Returns:
            {"items": [...], "total": int, "page": int, "perPage": int}
        """
        return self._request(
            "GET",
            "/assets/search",
            params={
                "q": q,
                "target": target,
                "kind": kind,
                "status": status,
                "trustLevel": trust_level,
                "sourceType": source_type,
                "entityId": entity_id,
                "entityIds": ",".join(entity_ids) if entity_ids else None,
                "dateFrom": date_from,
                "dateTo": date_to,
                "ninaAppearance": nina_appearance,
                "page": page,
                "perPage": per_page,
            },
        )

    # ------------------------------------------------------------------
    # MeetGreets
    # ------------------------------------------------------------------

    def list_meetgreets(self) -> dict[str, Any]:
        """ミーグリの一覧を取得する。"""
        return self._request("GET", "/meetgreets")

    def get_meetgreet(self, meetgreet_id: str) -> dict[str, Any]:
        """ミーグリを ID で取得する。"""
        return self._request("GET", f"/meetgreets/{meetgreet_id}")

    def create_meetgreet(
        self,
        date: str,
        format: str,
        *,
        single: str | None = None,
        label: str | None = None,
        classification: str | None = None,
        dossier_id: str | None = None,
        repo_collection_id: str | None = None,
    ) -> dict[str, Any]:
        """ミーグリを作る（素材置き場のドシエと X レポ収集も用意される）。

        **同じ ``(date, format, label)`` の回が既にあれば、新しく作らずそれを返す。**
        作成は数秒だが、タイムアウトして再送しても二重にはならない。

        X レポの収集はここでは走らない。``fetch_meetgreet_reports`` を別に呼ぶ。

        Args:
            date: 開催日（JST の ``YYYY-MM-DD``）
            format: ``"online"`` か ``"real"``
            single: シングル名（記事の frontmatter に出る）
            label: 回の呼び分け（``"通常"`` / ``"初限"`` / 会場名など）。
                同じ日に 2 回あるときはここで分ける
            classification: 機密レベル（既定 ``"internal"``）
            dossier_id: 既にあるドシエを使う
            repo_collection_id: 既にある X レポ収集を使う

        Returns:
            作ったミーグリ（``candidates`` に素材候補が付く）。
            **``reused`` はクライアントが足すキー**で、既にあった回が返ってきたか
            （HTTP 200）新しく作られたか（201）を表す。API の応答そのものには入っていない
        """
        payload: dict[str, Any] = {"date": date, "format": format}
        if single is not None:
            payload["single"] = single
        if label is not None:
            payload["label"] = label
        if classification is not None:
            payload["classification"] = classification
        if dossier_id is not None:
            payload["dossierId"] = dossier_id
        if repo_collection_id is not None:
            payload["repoCollectionId"] = repo_collection_id
        body, status = self._request(
            "POST", "/meetgreets", json=payload, with_status=True
        )
        return {**body, "reused": status == 200}

    def fetch_meetgreet_reports(
        self, meetgreet_id: str, *, timeout: int = 180
    ) -> dict[str, Any]:
        """X レポを収集する（作成時には走らないので最初の 1 回もこれ）。

        **数十秒かかる**（X API のページングと、取得した画像を 1 枚ずつ縮小して
        R2 に上げるため。実測で最大 80 秒程度）。既定のタイムアウトでは足りないので、
        この呼び出しだけ長めにしてある。Discord から呼ぶときは先に deferred ack すること。

        X の recent search は **直近 7 日**しか遡れない。開催から日が経っている回は
        ``fetched`` が 0 で返る。

        Args:
            meetgreet_id: ミーグリの ID
            timeout: 秒。既定 180

        Returns:
            ``{"fetched": n, "added": n, "mediaSaved": n}``
        """
        return self._request(
            "POST", f"/meetgreets/{meetgreet_id}/reports", timeout=timeout
        )

    # ------------------------------------------------------------------
    # Articles
    # ------------------------------------------------------------------

    def list_articles(
        self,
        *,
        q: str | None = None,
        type: str | None = None,
        dirty: bool | None = None,
        include_draft: bool | None = None,
        page: int | None = None,
        per_page: int | None = None,
    ) -> dict[str, Any]:
        """記事の一覧（本文は含まない）。``q`` はタイトル・本文の部分一致。"""
        params: dict[str, Any] = {
            "q": q,
            "type": type,
            "page": page,
            "perPage": per_page,
        }
        if dirty is not None:
            params["dirty"] = "true" if dirty else "false"
        if include_draft is not None:
            params["includeDraft"] = "true" if include_draft else "false"
        return self._request("GET", "/articles", params=params)

    def get_article(self, short_id: str) -> dict[str, Any]:
        """記事を 1 本取得する（本文・出典・楽観ロック用の ``updatedAt`` を含む）。"""
        return self._request("GET", f"/articles/{short_id}")

    def append_article(
        self,
        short_id: str,
        *,
        updated_at: str,
        body: str,
        article_updated_at: str | None = None,
        sources: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """本文を置き換えて出典を足す（1 トランザクション）。記事は push 待ちになる。

        一覧記事に 1 行足すための口。行の挿入位置は呼び出し側が決めて、追記後の本文全体を渡す。
        同じアセット（無ければ同じ URL）の出典が既にあれば足さないので、再送しても重複しない。

        Args:
            short_id: 記事の short_id
            updated_at: ``get_article`` で読んだ ``updatedAt``（楽観ロック）
            body: 追記後の本文（frontmatter を除く）
            article_updated_at: frontmatter の ``updated_at``（``YYYY-MM-DD``）。省略で変えない
            sources: ``[{"assetId": …, "url": …, "label": …, "date": "YYYY-MM-DD"}]``。
                ``assetId`` か ``url`` のどちらかが必要。``label`` 省略でアセットのタイトル。
                ``assetId`` は ``internal`` 以下のアセットだけ（より上は 403）

        Returns:
            ``{"shortId", "changed", "addedSources", "hadPendingEdits", "updatedAt"}``。
            ``hadPendingEdits`` が真なら、書く前から人の未 push の編集があった（自動で push しない）

        Raises:
            AkashicError: 409 は読んでから書くまでに記事が変わった（読み直して再送する）
        """
        payload: dict[str, Any] = {"updatedAt": updated_at, "body": body}
        if article_updated_at is not None:
            payload["articleUpdatedAt"] = article_updated_at
        if sources:
            payload["sources"] = sources
        return self._request("POST", f"/articles/{short_id}/append", json=payload)

    def push_article(
        self,
        short_id: str,
        *,
        subject: str | None = None,
        expected_updated_at: str | None = None,
        timeout: int = 60,
    ) -> dict[str, Any]:
        """この記事 1 本だけを公開リポジトリに push する（``article_push`` を持つキーだけ）。

        **その記事の未 push の変更をすべて出す。** ``append_article`` の応答の
        ``hadPendingEdits`` が真なら呼ばずに人に任せること。

        Args:
            short_id: 記事の short_id
            subject: コミットメッセージの件名
            expected_updated_at: ``append_article`` の応答の ``updatedAt``。それ以降に記事が
                編集されていたら push せず 409 になる

        Returns:
            ``{"pushed", "unchanged", "blocked", "conflicts", "commitUrl", "dbError"}``。
            ``conflicts`` が 1 なら GitHub 側が先に変わっている（Akashic で取り込み直す）

        Raises:
            AkashicError: 409 は ``expected_updated_at`` 以降の編集（``reason: "conflict"``）か、
                push 中にブランチが進んだ（``reason: "branch_moved"``。少し待って再送）
        """
        payload: dict[str, Any] = {}
        if subject is not None:
            payload["subject"] = subject
        if expected_updated_at is not None:
            payload["expectedUpdatedAt"] = expected_updated_at
        return self._request(
            "POST", f"/articles/{short_id}/push", json=payload, timeout=timeout
        )

    # ------------------------------------------------------------------
    # Entities
    # ------------------------------------------------------------------

    def list_entities(
        self,
        *,
        type: str | None = None,
        page: int = 1,
        per_page: int = 20,
    ) -> dict[str, Any]:
        """エンティティ一覧を取得する。"""
        return self._request(
            "GET",
            "/entities",
            params={"type": type, "page": page, "perPage": per_page},
        )

    def search_entities(
        self, q: str, *, type: str | None = None
    ) -> dict[str, Any]:
        """エンティティを名前で検索する。"""
        return self._request(
            "GET", "/entities", params={"q": q, "type": type}
        )

    def get_entity(self, entity_id: str) -> dict[str, Any]:
        """エンティティをIDで取得する（aliases含む）。"""
        return self._request("GET", f"/entities/{entity_id}")

    def get_entity_aliases(self, entity_id: str) -> list[str]:
        """エンティティのcanonicalName + aliasesをリストで返す。"""
        entity = self.get_entity(entity_id)
        aliases = entity.get("aliases", [])
        if not isinstance(aliases, list):
            aliases = []
        return [entity["canonicalName"], *aliases]

    def create_entity(
        self, type: str, canonical_name: str
    ) -> dict[str, Any]:
        """エンティティを作成する（既存なら既存を返す）。"""
        return self._request(
            "POST",
            "/entities",
            json={"type": type, "canonicalName": canonical_name},
        )

    # ------------------------------------------------------------------
    # Relations
    # ------------------------------------------------------------------

    def list_relations(
        self,
        asset_id: str,
        *,
        relation_type: str | None = None,
    ) -> dict[str, Any]:
        """アセットのリレーション一覧を取得する。

        Returns:
            {"asSource": [...], "asTarget": [...]}
        """
        return self._request(
            "GET",
            f"/assets/{asset_id}/relations",
            params={"relationType": relation_type},
        )

    def create_relation(
        self,
        source_id: str,
        target_id: str,
        relation_type: str,
        *,
        metadata: dict[str, Any] | None = None,
        sort_order: int = 0,
    ) -> dict[str, Any]:
        """アセット間のリレーションを作成する。

        Args:
            source_id: 親・元側のアセットID
            target_id: 子・先側のアセットID
            relation_type: "parent_child", "derived_from", "reference", "same_content"
        """
        body: dict[str, Any] = {
            "targetId": target_id,
            "relationType": relation_type,
            "sortOrder": sort_order,
        }
        if metadata:
            body["metadata"] = metadata
        return self._request("POST", f"/assets/{source_id}/relations", json=body)

    def delete_relation(
        self, asset_id: str, relation_id: str
    ) -> dict[str, Any]:
        """リレーションを削除する。"""
        return self._request(
            "DELETE", f"/assets/{asset_id}/relations/{relation_id}"
        )

    # ------------------------------------------------------------------
    # Upload
    # ------------------------------------------------------------------

    def upload(
        self,
        file_path: str | Path,
        *,
        title: str | None = None,
        kind: str | None = None,
        status: str | None = None,
        canonical_date: str | None = None,
        source_type: str | None = None,
        entities: list[dict[str, Any]] | None = None,
        source_records: list[dict[str, Any]] | None = None,
        texts: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """ファイルをアップロードしてアセットを作成する。

        メタデータ（entities, source_records, texts 等）を同時に渡すことで
        アップロードとメタデータ付与を1リクエストで行える。

        Returns:
            {"id": "...", "duplicate": false}
            or {"duplicate": true, "existingId": "...", "message": "..."}
        """
        path = Path(file_path)
        mime = _guess_mime(path)
        content = path.read_bytes()
        return self.upload_bytes(
            content,
            path.name,
            mime,
            title=title,
            kind=kind,
            status=status,
            canonical_date=canonical_date,
            source_type=source_type,
            entities=entities,
            source_records=source_records,
            texts=texts,
        )

    def upload_bytes(
        self,
        content: bytes,
        filename: str,
        mime_type: str = "application/octet-stream",
        *,
        title: str | None = None,
        kind: str | None = None,
        status: str | None = None,
        canonical_date: str | None = None,
        source_type: str | None = None,
        entities: list[dict[str, Any]] | None = None,
        source_records: list[dict[str, Any]] | None = None,
        texts: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """バイト列からファイルをアップロードする。

        Discord等でダウンロード済みのバイナリをそのまま渡す場合に使う。
        メタデータ（entities, source_records, texts 等）を同時に渡すことで
        アップロードとメタデータ付与を1リクエストで行える。

        Google Drive への直接アップロード方式を使用し、
        Vercel のボディサイズ制限（4.5MB）を回避する。
        """
        sha256 = hashlib.sha256(content).hexdigest()

        # Step 1: initiate — 重複チェック & resumable upload URL 取得
        initiate_body: dict[str, Any] = {
            "filename": filename,
            "mimeType": mime_type,
            "sha256": sha256,
        }
        # 重複時にメタデータを更新するための情報
        metadata: dict[str, Any] = {}
        if status:
            metadata["status"] = status
        if source_type:
            metadata["sourceType"] = source_type
        if canonical_date:
            metadata["canonicalDate"] = canonical_date
        if entities:
            metadata["entities"] = entities
        if source_records:
            metadata["sourceRecords"] = source_records
        if metadata:
            initiate_body["metadata"] = metadata

        initiate_resp = self._request(
            "POST", "/upload/initiate", json=initiate_body
        )

        if initiate_resp.get("duplicate"):
            return initiate_resp

        upload_url = initiate_resp["uploadUrl"]

        # Step 2: Google Drive に直接アップロード
        put_resp = requests.put(
            upload_url,
            data=content,
            headers={
                "Content-Type": mime_type,
                "Content-Length": str(len(content)),
            },
            timeout=max(self._timeout, 300),
        )
        if put_resp.status_code >= 400:
            raise AkashicError(
                put_resp.status_code,
                f"Direct Drive upload failed: {put_resp.text}",
            )
        drive_file_id = put_resp.json()["id"]

        # Step 3: complete — アセットレコード作成
        complete_body: dict[str, Any] = {
            "driveFileId": drive_file_id,
            "filename": filename,
            "mimeType": mime_type,
            "fileSize": len(content),
            "sha256": sha256,
        }
        if title:
            complete_body["title"] = title
        if kind:
            complete_body["kind"] = kind
        if status:
            complete_body["status"] = status
        if canonical_date:
            complete_body["canonicalDate"] = canonical_date
        if source_type:
            complete_body["sourceType"] = source_type
        if entities:
            complete_body["entities"] = entities
        if source_records:
            complete_body["sourceRecords"] = source_records
        if texts:
            complete_body["texts"] = texts

        return self._request("POST", "/upload/complete", json=complete_body)

    # ------------------------------------------------------------------
    # Thumbnail
    # ------------------------------------------------------------------

    def upload_thumbnail(
        self,
        asset_id: str,
        image_data: bytes,
        filename: str = "thumbnail.jpg",
        mime_type: str = "image/jpeg",
    ) -> dict[str, Any]:
        """アセットにサムネイル画像をアップロードする。

        画像は R2 にアップロードされ、thumbnailUrl が更新される。

        Args:
            asset_id: 対象アセットID
            image_data: サムネイル画像のバイナリデータ
            filename: ファイル名
            mime_type: MIMEタイプ
        """
        return self._request(
            "POST",
            f"/assets/{asset_id}/thumbnail",
            files={"file": (filename, image_data, mime_type)},
        )

    # ------------------------------------------------------------------
    # File URL helper
    # ------------------------------------------------------------------

    def file_url(self, asset: dict[str, Any]) -> str | None:
        """アセットの画像/ファイルURLをフルURLで返す。

        storageUrl/thumbnailUrl が相対パスの場合は base_url を付与する。
        """
        url = asset.get("thumbnailUrl") or asset.get("storageUrl")
        if not url:
            return None
        if url.startswith("/"):
            return f"{self.base_url}{url}"
        return url



def _guess_mime(path: Path) -> str:
    ext_map = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mp3": "audio/mpeg",
        ".pdf": "application/pdf",
        ".txt": "text/plain",
    }
    return ext_map.get(path.suffix.lower(), "application/octet-stream")
