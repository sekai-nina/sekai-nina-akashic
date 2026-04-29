"""Akashic REST API v1 Python client."""

from __future__ import annotations

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
            timeout=self._timeout,
        )
        body = resp.json() if resp.content else None
        if resp.status_code >= 400:
            raise AkashicError(resp.status_code, body)
        return body

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
        page: int = 1,
        per_page: int = 20,
    ) -> dict[str, Any]:
        """全文検索。

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
                "page": page,
                "perPage": per_page,
            },
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
        data = _build_upload_data(
            title=title,
            kind=kind,
            status=status,
            canonical_date=canonical_date,
            source_type=source_type,
            entities=entities,
            source_records=source_records,
            texts=texts,
        )
        with open(path, "rb") as f:
            return self._request(
                "POST",
                "/upload",
                data=data,
                files={"file": (path.name, f, mime)},
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
        """
        data = _build_upload_data(
            title=title,
            kind=kind,
            status=status,
            canonical_date=canonical_date,
            source_type=source_type,
            entities=entities,
            source_records=source_records,
            texts=texts,
        )
        return self._request(
            "POST",
            "/upload",
            data=data,
            files={"file": (filename, content, mime_type)},
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


def _build_upload_data(
    *,
    title: str | None,
    kind: str | None,
    status: str | None,
    canonical_date: str | None,
    source_type: str | None,
    entities: list[dict[str, Any]] | None,
    source_records: list[dict[str, Any]] | None,
    texts: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    """アップロード用の multipart form data フィールドを構築する."""
    import json

    data: dict[str, Any] = {}
    if title:
        data["title"] = title
    if kind:
        data["kind"] = kind
    if status:
        data["status"] = status
    if canonical_date:
        data["canonicalDate"] = canonical_date
    if source_type:
        data["sourceType"] = source_type
    if entities:
        data["entities"] = json.dumps(entities)
    if source_records:
        data["sourceRecords"] = json.dumps(source_records)
    if texts:
        data["texts"] = json.dumps(texts)
    return data


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
