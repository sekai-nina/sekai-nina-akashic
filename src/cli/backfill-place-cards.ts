/**
 * 既存記事の本文に、紐づく聖地の Google マップのリンクカードを後から置く (#324)。
 *
 * #313 から、おでかけ記事は生成・AI の組み込みのときに行った場所のカードを本文に置くが、
 * それより前の記事とワークフローの外で書いた記事には無い。ArticlePlace のある記事を回り、
 * `insertPlaceCards` (名前が出てくる `##` の末尾、無ければ本文の最後) でカードを足す。
 *
 * - カードにするのは push で frontmatter に載る聖地 (`isPublishablePlace`) だけ。
 *   confidential 以上の聖地の URL を本文に出さない
 * - 同じ URL のカードが既にあれば足さない (冪等。2 回目は全件スキップ)
 * - 座標の行 (`lat:` / `lng:`) が無いころに置いたカードには座標を足す (写真が取れないときの地図サムネイル用)
 * - 写真 (`image:`) の無い Google マップのカードには、Google のリンクプレビューと同じお店の写真と住所を足す
 * - Google マップの埋め込み (`<iframe>`) がある記事は書かない (手で書いた記事が場所ごとに地図を埋め込んでいる)
 * - 書いた記事は `dirty` と `editedAt` を立てる (push の対象にし、取り込みの上書きから守る)。
 *   読んだあとに画面で保存された記事は `updatedAt` が変わるので書かない
 *
 * 書き込みは DIRECT_URL (RLS バイパス)。既定は dry-run、--apply で書く。--show で新しい本文も出す。
 *
 * Usage:
 *   pnpm cli:backfill-place-cards            # dry-run
 *   pnpm cli:backfill-place-cards --show     # dry-run + 本文
 *   pnpm cli:backfill-place-cards --apply
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

import { addCardCoords, insertPlaceCards } from "@/lib/article-workflow/templates/outing";
import type { DossierPlace } from "@/lib/article-workflow/templates/types";
import { isPublishablePlace } from "@/lib/articles/frontmatter";
import { addCardPreviews } from "@/lib/places/google-maps-preview";

if (!process.env.DIRECT_URL) {
  console.error("DIRECT_URL が未設定です (このスクリプトは RLS バイパス接続が必須)");
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const SHOW = args.includes("--show");

async function main() {
  console.log(`記事に聖地のカードを置く${APPLY ? "" : " (dry-run。書くには --apply)"}`);

  const articles = await prisma.article.findMany({
    where: { places: { some: {} } },
    orderBy: { path: "asc" },
    select: {
      id: true, path: true, body: true, updatedAt: true, editedAt: true,
      places: {
        orderBy: { sortOrder: "asc" },
        select: {
          place: {
            select: {
              id: true, classification: true, latitude: true, longitude: true, address: true, googleMapsUrl: true,
              entity: { select: { canonicalName: true } },
            },
          },
        },
      },
    },
  });

  let written = 0;
  let cards = 0;
  let coords = 0;
  let photoCount = 0;
  const skipped: string[] = [];
  for (const a of articles) {
    const places: DossierPlace[] = a.places
      .map((ap) => ap.place)
      .filter(isPublishablePlace)
      .map((p) => ({
        name: p.entity.canonicalName,
        placeId: p.id,
        lat: p.latitude,
        lng: p.longitude,
        address: p.address,
        googleMapsUrl: p.googleMapsUrl,
        note: "",
      }));
    if (places.length === 0) {
      skipped.push(`${a.path}: サイトに出す聖地が無い`);
      continue;
    }
    if (/<iframe[^>]*src="https:\/\/www\.google\.com\/maps/.test(a.body)) {
      skipped.push(`${a.path}: Google マップの埋め込みがもうある`);
      continue;
    }
    const c = addCardCoords(a.body, places);
    const inserted = insertPlaceCards(c.body, places);
    const photos = await addCardPreviews(inserted.body);
    const r = { ...inserted, body: photos.body };
    if (r.body === a.body) {
      skipped.push(`${a.path}: カードはもうある`);
      continue;
    }

    written++;
    cards += r.placements.length;
    coords += c.names.length;
    photoCount += photos.added;
    console.log(`\n  ${a.path}${a.editedAt ? " (未 push の編集あり)" : ""}`);
    for (const name of c.names) console.log(`    - ${name} → 既存のカードに座標を足す`);
    for (const p of r.placements) console.log(`    - ${p.name} → ${p.heading ? `## ${p.heading} の末尾` : "本文の最後"}`);
    if (SHOW) console.log(r.body.replace(/^/gm, "      | "));
    if (!APPLY) continue;

    const res = await prisma.article.updateMany({
      where: { id: a.id, updatedAt: a.updatedAt },
      data: { body: r.body, dirty: true, editedAt: new Date() },
    });
    if (res.count === 0) console.log("    ! 読んだあとに更新されたので書かなかった (もう一度流す)");
  }

  console.log(`\n${APPLY ? "書いた" : "書く"}記事: ${written} 件 (足すカード ${cards} 枚、座標を足すカード ${coords} 枚、写真を足すカード ${photoCount} 枚)`);
  if (skipped.length) {
    console.log(`\n--- 書かない記事 (${skipped.length} 件) ---`);
    for (const s of skipped) console.log(`  ${s}`);
  }
  if (!APPLY) console.log("\ndry-run のため書き込みはしていません。--apply を付けると反映します");
}

main()
  .catch((e) => {
    console.error("ERR", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
