"""Backfill blog posts with embedded image placeholders.

For each blog text asset in Akashic:
1. Extract post_id from source record URL
2. Re-fetch blog with blog_downloader to get image positions
3. Upload images (skipped if duplicate) and collect asset IDs
4. Replace {{IMG:N}} with {{IMG:asset_id}} in body_text_with_images
5. Update the AssetText content

Usage:
    pip install blog-downloader  # or use the local package
    python scripts/backfill-blog-images.py [--dry-run] [--limit N]

Requires:
    AKASHIC_API_KEY env var (or .env file)
    AKASHIC_BASE_URL env var (default: https://akashic.sekai-nina.com)
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv

load_dotenv()

from akashic import AkashicClient
from blog_downloader.api import BlogClient

AKASHIC_BASE_URL = os.environ.get("AKASHIC_BASE_URL", "https://akashic.sekai-nina.com")
AKASHIC_API_KEY = os.environ.get("AKASHIC_API_KEY", "")
BLOG_URL_PATTERN = re.compile(r"hinatazaka46\.com/s/official/diary/detail/(\d+)")
IMG_PLACEHOLDER = re.compile(r"\{\{IMG:(\d+)\}\}")
JST = timezone(timedelta(hours=9))


def extract_post_id(url: str) -> int | None:
    m = BLOG_URL_PATTERN.search(url)
    return int(m.group(1)) if m else None


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill blog images into Akashic")
    parser.add_argument("--dry-run", action="store_true", help="Don't actually update")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of posts to process")
    parser.add_argument("--member", type=str, default=None, help="Filter by member name")
    args = parser.parse_args()

    if not AKASHIC_API_KEY:
        print("Error: AKASHIC_API_KEY is required")
        sys.exit(1)

    akashic = AkashicClient(AKASHIC_BASE_URL, AKASHIC_API_KEY, timeout=60)
    blog_client = BlogClient(delay=1.0)

    # Fetch all text assets with blog source records
    page = 1
    per_page = 50
    processed = 0
    updated = 0
    skipped = 0
    errors = 0

    while True:
        result = akashic.list_assets(
            kind="text",
            source_type="web",
            page=page,
            per_page=per_page,
        )
        items = result.get("items", [])
        if not items:
            break

        for item in items:
            if args.limit and processed >= args.limit:
                break

            asset_id = item.get("id")
            if not asset_id:
                continue

            # Get full asset with texts and source records
            asset = akashic.get_asset(asset_id)
            texts = asset.get("texts", [])
            source_records = asset.get("sourceRecords", [])

            # Find blog URL and extract post_id
            post_id = None
            for sr in source_records:
                url = sr.get("url", "")
                post_id = extract_post_id(url)
                if post_id:
                    break

            if not post_id:
                continue

            # Find body text
            body_text = None
            body_text_id = None
            for t in texts:
                if t.get("textType") == "body":
                    body_text = t.get("content", "")
                    body_text_id = t.get("id")
                    break

            if not body_text or not body_text_id:
                continue

            # Skip if already has resolved placeholders (non-numeric)
            if re.search(r"\{\{IMG:[a-zA-Z]", body_text):
                skipped += 1
                continue

            # Filter by member if specified
            if args.member:
                title = asset.get("title", "")
                entities = asset.get("entities", [])
                entity_names = [e.get("entity", {}).get("canonicalName", "") for e in entities]
                if args.member not in title and args.member not in " ".join(entity_names):
                    continue

            processed += 1
            title = asset.get("title", "")
            print(f"\n[{processed}] post_id={post_id} title={title[:40]}")

            # Re-fetch blog to get image positions
            try:
                post = blog_client.get_post(str(post_id), post_id, fetch_images=True)
            except Exception as e:
                print(f"  Error fetching blog: {e}")
                errors += 1
                continue

            if not post:
                print(f"  Blog post not found")
                errors += 1
                continue

            if not post.image_urls:
                print(f"  No images in blog post")
                skipped += 1
                continue

            body_with_images = post.body_text_with_images
            if not body_with_images or "{{IMG:" not in body_with_images:
                print(f"  No image placeholders in parsed text")
                skipped += 1
                continue

            # Upload images and collect asset IDs
            image_asset_ids: dict[int, str] = {}
            canonical_date = asset.get("canonicalDate")
            entities = asset.get("entities", [])
            entity_list = [
                {"entityId": e["entity"]["id"], "roleLabel": e.get("roleLabel", "")}
                for e in entities
                if e.get("entity", {}).get("id")
            ]
            source_record_list = [
                {
                    "sourceKind": sr.get("sourceKind", "url"),
                    "url": sr.get("url", ""),
                    "title": sr.get("title", ""),
                    "publisher": sr.get("publisher", ""),
                    "publishedAt": sr.get("publishedAt"),
                }
                for sr in source_records
                if sr.get("url")
            ]

            total_imgs = len(post.images)
            for i, img in enumerate(post.images):
                # Find the index in image_urls by matching the URL
                img_index = None
                for idx, url in enumerate(post.image_urls):
                    if url == img.url:
                        img_index = idx
                        break
                if img_index is None:
                    continue

                image_title = f"{title} ({i + 1}/{total_imgs})" if total_imgs > 1 else title
                print(f"  Uploading image {i + 1}/{total_imgs}: {img.filename}")

                if args.dry_run:
                    image_asset_ids[img_index] = f"dry-run-{img_index}"
                    continue

                try:
                    result = akashic.upload_bytes(
                        img.data,
                        img.filename,
                        "image/jpeg",
                        title=image_title,
                        kind="image",
                        status="organized",
                        canonical_date=canonical_date,
                        source_type="web",
                        entities=entity_list,
                        source_records=source_record_list,
                    )
                    aid = result.get("id") or result.get("existingId", "")
                    if aid:
                        image_asset_ids[img_index] = aid
                        print(f"    -> {aid}" + (" (existing)" if result.get("duplicate") else ""))
                except Exception as e:
                    print(f"    Upload error: {e}")

            if not image_asset_ids:
                print(f"  No images uploaded successfully")
                errors += 1
                continue

            # Replace {{IMG:N}} with {{IMG:asset_id}}
            def replace_placeholder(m: re.Match) -> str:
                idx = int(m.group(1))
                aid = image_asset_ids.get(idx)
                if aid:
                    return f"{{{{IMG:{aid}}}}}"
                return m.group(0)  # Keep original if no asset ID

            new_content = IMG_PLACEHOLDER.sub(replace_placeholder, body_with_images)

            print(f"  Updating text content ({len(image_asset_ids)} images resolved)")
            if not args.dry_run:
                try:
                    akashic._request(
                        "PATCH",
                        f"/texts/{body_text_id}",
                        json={"content": new_content},
                    )
                    updated += 1
                except Exception as e:
                    print(f"  Update error: {e}")
                    errors += 1
            else:
                updated += 1

        if args.limit and processed >= args.limit:
            break
        if len(items) < per_page:
            break
        page += 1

    print(f"\nDone: {processed} processed, {updated} updated, {skipped} skipped, {errors} errors")


if __name__ == "__main__":
    main()
