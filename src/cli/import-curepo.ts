/**
 * 既存 curepo (Python/SQLite) のデータを akashic (Supabase/Prisma + R2) へ移行する。
 *
 * curepo の収集(collections)/ツイート(tweets)/画像(media) を読み、
 *   - collections → RepoCollection（sourceLegacyId で冪等化）
 *   - tweets      → RepoTweet（status keep/reject/undecided をそのまま）
 *   - media       → ローカル画像を 640px WebP に軽量化して R2 へ。RepoTweetMedia を作成
 * を行う。書き込みは prismaInternal 相当（DIRECT_URL / RLS バイパス）。
 *
 * 依存を増やさないため SQLite の読み出しは `sqlite3 -json` CLI に委譲する。
 *
 * Usage:
 *   pnpm cli:import-curepo -- [--curepo-dir=PATH] [--dry-run] [--limit=N]
 *
 * 既定の --curepo-dir は cwd の ../curepo。ローカル worktree からはフルパス指定推奨。
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import "dotenv/config";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME ?? "akashic-thumbnails";
const r2Configured = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY
);
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
  },
});

const GALLERY_WIDTH = 640;

interface CurepoCollection {
  id: number;
  name: string;
  hashtags: string;
  operator: string;
  query: string;
  start_date: string | null;
  end_date: string | null;
  exclude_retweets: number;
  lang_ja: number;
  created_at: string | null;
  last_fetched_at: string | null;
}
interface CurepoTweet {
  collection_id: number;
  tweet_id: string;
  author_username: string | null;
  author_name: string | null;
  text: string | null;
  created_at: string | null;
  like_count: number;
  retweet_count: number;
  reply_count: number;
  quote_count: number;
  url: string | null;
  status: string;
  note: string | null;
}
interface CurepoMedia {
  collection_id: number;
  tweet_id: string;
  media_key: string;
  type: string | null;
  remote_url: string | null;
  local_path: string | null;
  width: number | null;
  height: number | null;
  alt_text: string | null;
}

function queryJson<T>(dbPath: string, sql: string): T[] {
  const out = execFileSync("sqlite3", [dbPath, "-json", sql], {
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const trimmed = out.trim();
  return trimmed ? (JSON.parse(trimmed) as T[]) : [];
}

/** "YYYY-MM-DD HH:MM:SS"(UTC) / ISO8601 を Date に。失敗時 null。 */
function parseDate(s: string | null): Date | null {
  if (!s) return null;
  let v = s;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(v) && !/[zZ+]/.test(v)) {
    v = v.replace(" ", "T") + "Z";
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function mapStatus(s: string): "undecided" | "keep" | "reject" {
  return s === "keep" || s === "reject" ? s : "undecided";
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1]) : 0;
  const dirArg = args.find((a) => a.startsWith("--curepo-dir="));
  const curepoDir = resolve(dirArg ? dirArg.split("=")[1] : join(process.cwd(), "../curepo"));

  const dbPath = join(curepoDir, "curepo.db");
  const mediaDir = join(curepoDir, "media");
  if (!existsSync(dbPath)) {
    console.error(`curepo.db not found at ${dbPath} (use --curepo-dir=PATH)`);
    process.exit(1);
  }
  if (!process.env.DIRECT_URL) {
    console.error("DIRECT_URL is required (postgres role, bypasses RLS)");
    process.exit(1);
  }
  if (!r2Configured) {
    console.warn("R2 未設定: 画像はアップロードせず imageKey=null で取り込みます");
  }

  const collections = queryJson<CurepoCollection>(dbPath, "SELECT * FROM collections ORDER BY id ASC");
  const allTweets = queryJson<CurepoTweet>(dbPath, "SELECT * FROM tweets");
  const allMedia = queryJson<CurepoMedia>(dbPath, "SELECT * FROM media");

  const tweetsByColl = new Map<number, CurepoTweet[]>();
  for (const t of allTweets) {
    if (!tweetsByColl.has(t.collection_id)) tweetsByColl.set(t.collection_id, []);
    tweetsByColl.get(t.collection_id)!.push(t);
  }
  const mediaByTweet = new Map<string, CurepoMedia[]>();
  for (const m of allMedia) {
    const key = `${m.collection_id}:${m.tweet_id}`;
    if (!mediaByTweet.has(key)) mediaByTweet.set(key, []);
    mediaByTweet.get(key)!.push(m);
  }

  console.log(
    `curepo: ${collections.length} collections / ${allTweets.length} tweets / ${allMedia.length} media`
  );

  let collDone = 0;
  let tweetsCreated = 0;
  let tweetsSkipped = 0;
  let imagesUploaded = 0;
  let imagesMissing = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;

  for (const c of collections) {
    if (limit && collDone >= limit) break;
    collDone++;

    let groups: unknown = [];
    try {
      groups = JSON.parse(c.hashtags || "[]");
    } catch {
      groups = [];
    }

    // RepoCollection（sourceLegacyId で冪等化）
    let repoCollectionId: string;
    const existingColl = await prisma.repoCollection.findUnique({
      where: { sourceLegacyId: c.id },
      select: { id: true },
    });
    if (existingColl) {
      repoCollectionId = existingColl.id;
    } else if (dryRun) {
      repoCollectionId = `(dry:${c.id})`;
    } else {
      const created = await prisma.repoCollection.create({
        data: {
          name: c.name,
          groups: groups as object,
          groupOp: c.operator || "or",
          query: c.query,
          startDate: c.start_date,
          endDate: c.end_date,
          excludeRetweets: !!c.exclude_retweets,
          langJa: !!c.lang_ja,
          sourceLegacyId: c.id,
          lastFetchedAt: parseDate(c.last_fetched_at),
          createdAt: parseDate(c.created_at) ?? new Date(),
        },
      });
      repoCollectionId = created.id;
    }

    const tweets = tweetsByColl.get(c.id) ?? [];
    for (const t of tweets) {
      // 既存（再実行時）は skip
      if (!dryRun) {
        const exists = await prisma.repoTweet.findUnique({
          where: {
            collectionId_tweetId: { collectionId: repoCollectionId, tweetId: t.tweet_id },
          },
          select: { id: true },
        });
        if (exists) {
          tweetsSkipped++;
          continue;
        }
      }

      const media = mediaByTweet.get(`${c.id}:${t.tweet_id}`) ?? [];

      // 画像を軽量化して R2 へ（トランザクション外・1枚ずつ）
      const mediaRows: {
        mediaKey: string;
        type: string;
        remoteUrl: string | null;
        imageKey: string | null;
        width: number | null;
        height: number | null;
        altText: string;
      }[] = [];

      for (const m of media) {
        let imageKey: string | null = null;
        const filePath = m.local_path ? join(mediaDir, m.local_path) : null;
        if (r2Configured && filePath && existsSync(filePath)) {
          try {
            const webp = await sharp(filePath)
              .rotate()
              .resize(GALLERY_WIDTH, null, { withoutEnlargement: true })
              .webp({ quality: 80 })
              .toBuffer();
            const key = `repo/${repoCollectionId}/${t.tweet_id}/${m.media_key}.webp`;
            if (!dryRun) {
              await s3.send(
                new PutObjectCommand({
                  Bucket: R2_BUCKET_NAME,
                  Key: key,
                  Body: webp,
                  ContentType: "image/webp",
                  CacheControl: "public, max-age=31536000, immutable",
                })
              );
            }
            imageKey = key;
            imagesUploaded++;
            bytesAfter += webp.length;
          } catch (err) {
            console.error(`  image fail ${m.local_path}: ${(err as Error).message.slice(0, 120)}`);
            imagesMissing++;
          }
        } else if (filePath) {
          imagesMissing++;
        }
        mediaRows.push({
          mediaKey: m.media_key,
          type: m.type || "photo",
          remoteUrl: m.remote_url,
          imageKey,
          width: m.width,
          height: m.height,
          altText: m.alt_text || "",
        });
      }

      if (dryRun) {
        tweetsCreated++;
        continue;
      }

      await prisma.repoTweet.create({
        data: {
          collectionId: repoCollectionId,
          tweetId: t.tweet_id,
          authorUsername: t.author_username || "",
          authorName: t.author_name || "",
          text: t.text || "",
          tweetedAt: parseDate(t.created_at),
          likeCount: t.like_count ?? 0,
          retweetCount: t.retweet_count ?? 0,
          replyCount: t.reply_count ?? 0,
          quoteCount: t.quote_count ?? 0,
          url: t.url || `https://x.com/i/status/${t.tweet_id}`,
          status: mapStatus(t.status),
          note: t.note || "",
          media: { create: mediaRows },
        },
      });
      tweetsCreated++;
    }

    console.log(
      `  [${c.id}] ${c.name.slice(0, 40)} — tweets:${tweets.length}` + (dryRun ? " (dry-run)" : "")
    );
  }

  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;
  console.log(
    `\nDone: ${collDone} collections, ${tweetsCreated} tweets created, ${tweetsSkipped} skipped, ` +
      `${imagesUploaded} images uploaded, ${imagesMissing} missing`
  );
  if (bytesAfter) console.log(`Images (after): ${mb(bytesAfter)}`);

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
