/**
 * 既存記事の `locations` の聖地 (place_id) を ArticlePlace に移す (#283)。
 *
 * 記事↔聖地の正を `frontmatterExtra.locations` から ArticlePlace に移したので、取り込み済みの
 * 記事に残っている `place_id` の要素を行にし、`frontmatterExtra.locations` から抜く
 * (座標直書きの要素は残す。残りが無ければキーごと消す)。
 *
 * 記事ごとに:
 *   1. `locations` に `place_id` の要素が無ければスキップ (冪等。2 回目は全件ここで止まる)
 *   2. 指す聖地が akashic に無い要素があればスキップして報告 (外部キーで入れられない)
 *   3. 移す前と後で push の Markdown (出典は除く) を組み立て、1 バイトでも違えばスキップして報告
 *      (name が聖地の正式名と違う、place_id の要素に他のキーがある、等)
 *   4. ArticlePlace を作り、`frontmatterExtra` を書き換える (1 トランザクション)
 *
 * 出力が変わらないことを確かめてから書くので dirty は立てない。`updatedAt` は進める
 * (backfill 前に開いた編集画面が聖地 0 件のまま保存して、移した行を消すのを `conflict` で止める)。
 *
 * 書き込みは DIRECT_URL (RLS バイパス)。既定は dry-run、--apply で書く。
 *
 * Usage:
 *   pnpm cli:backfill-article-places            # dry-run
 *   pnpm cli:backfill-article-places --apply
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

import { renderArticleMarkdown, splitLocations, type ArticlePlaceRow } from "@/lib/articles/frontmatter";

if (!process.env.DIRECT_URL) {
  console.error("DIRECT_URL が未設定です (このスクリプトは RLS バイパス接続が必須)");
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
const APPLY = process.argv.slice(2).includes("--apply");

async function main() {
  console.log(`記事の聖地を ArticlePlace に移す${APPLY ? "" : " (dry-run。書くには --apply)"}`);

  const [articles, places] = await Promise.all([
    prisma.article.findMany({
      orderBy: { path: "asc" },
      select: {
        id: true, shortId: true, path: true, slug: true, title: true, type: true, tags: true,
        body: true, date: true, dateDisplay: true, dateMode: true, publishedAt: true,
        articleUpdatedAt: true, draft: true, unlisted: true, ongoing: true, lat: true, lng: true,
        frontmatterExtra: true,
        places: { select: { placeId: true } },
      },
    }),
    prisma.place.findMany({ select: { id: true, classification: true, entity: { select: { canonicalName: true } } } }),
  ]);
  const placeById = new Map(places.map((p) => [p.id, p]));

  const stats = { moved: 0, rows: 0 };
  const problems: string[] = [];

  for (const a of articles) {
    const extra = a.frontmatterExtra;
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) continue;
    const split = splitLocations(extra as Record<string, unknown>);
    if (!split.places.length) continue;

    const missing = split.places.filter((e) => !placeById.has(e.placeId));
    if (missing.length) {
      problems.push(`${a.path}: 聖地が無い ${missing.map((e) => `${e.placeId} (${e.name})`).join(", ")}`);
      continue;
    }
    // 既に行がある (画面で付けた等) のに locations にも残っている → 二重になるので人が見る
    const existing = new Set(a.places.map((p) => p.placeId));
    const dup = split.places.filter((e) => existing.has(e.placeId));
    if (dup.length) {
      problems.push(`${a.path}: ArticlePlace に既にある ${dup.map((e) => e.name).join(", ")}`);
      continue;
    }

    const rows: ArticlePlaceRow[] = split.places.map((e, i) => {
      const pl = placeById.get(e.placeId)!;
      return { placeId: e.placeId, name: pl.entity.canonicalName, classification: pl.classification, sortOrder: i };
    });
    const before = renderArticleMarkdown({ ...a, sources: [], places: [] }).markdown;
    const after = renderArticleMarkdown({ ...a, frontmatterExtra: split.extra, sources: [], places: rows }).markdown;
    if (before !== after) {
      problems.push(`${a.path}: 移すと push の出力が変わる (name が正式名と違う・聖地が非公開・他のキーがある等)`);
      continue;
    }

    stats.moved++;
    stats.rows += rows.length;
    console.log(`  ${a.path}: ${rows.map((r) => r.name).join(" / ")}`);
    if (!APPLY) continue;

    await prisma.$transaction([
      prisma.articlePlace.createMany({
        data: rows.map((r) => ({ articleId: a.id, placeId: r.placeId, sortOrder: r.sortOrder })),
      }),
      prisma.$executeRaw`UPDATE "Article" SET "frontmatterExtra" = ${JSON.stringify(split.extra)}::jsonb, "updatedAt" = now() WHERE id = ${a.id}`,
    ]);
  }

  console.log(`\n${APPLY ? "移した" : "移す"}記事: ${stats.moved} 件 (聖地 ${stats.rows} 件)`);
  if (problems.length) {
    console.log(`\n--- 移さなかった記事 (${problems.length} 件) — locations はそのまま残る ---`);
    for (const p of problems) console.log(`  ${p}`);
  }
  if (!APPLY) console.log("\ndry-run のため書き込みはしていません。--apply を付けると反映します");
}

main()
  .catch((e) => {
    console.error("ERR", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
