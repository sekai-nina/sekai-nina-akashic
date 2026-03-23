# akashic — Python client

Akashic REST API v1 の Python クライアント。

## インストール

```bash
pip install -e clients/python
# または
pip install clients/python
```

## 使い方

```python
from akashic import AkashicClient

client = AkashicClient("http://localhost:3000", "ak_your_key_here")

# アセット一覧
result = client.list_assets(kind="image", page=1)
for asset in result["items"]:
    print(asset["title"], client.file_url(asset))

# アセット作成（メタデータのみ）
asset = client.create_asset(
    kind="text",
    title="ブログ記事",
    source_type="web",
    canonical_date="2024-01-15T00:00:00.000Z",
    texts=[{"textType": "body", "content": "本文テキスト..."}],
    source_records=[{
        "sourceKind": "url",
        "url": "https://ameblo.jp/example/entry-123",
        "title": "ブログタイトル",
        "publisher": "Ameba",
    }],
)

# ファイルアップロード
result = client.upload("photo.jpg", title="ブログ写真")
if not result["duplicate"]:
    client.update_asset(result["id"], status="organized")

# バイト列からアップロード（Discord bot等で使う場合）
result = client.upload_bytes(image_bytes, "photo.jpg", "image/jpeg")

# 検索
results = client.search("坂井新奈", kind="image")
for item in results["items"]:
    print(item["assetTitle"], item["snippet"])

# エンティティ
entity = client.create_entity("tag", "ブログ")
entities = client.search_entities("坂井")
```

## API ドキュメント

詳細は [docs/api.md](../../docs/api.md) を参照。
