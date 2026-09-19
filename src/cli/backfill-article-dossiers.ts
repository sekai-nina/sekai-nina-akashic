/**
 * 既存記事に素材ドシエを付ける (#41)。
 *
 * クリップを「この記事に足す」= その記事のドシエへ移す、なので記事にはドシエが要る。
 * 記事には出典アセットがあるので空にはならない。
 *
 * 記事ごとに:
 *   1. `Article.dossierId` が埋まっていればスキップ (冪等)
 *   2. `frontmatterExtra.dossier.id` が指すドシエが実在すれば、それにリンクするだけ (中身は触らない。
 *      旧ワークフローで人が選んだ素材なので)
 *   3. `applied` (かつ `public`) で `assetId` のある `ArticleSource` があれば、ドシエを新規作成して
 *      それらを `DossierItem` (caption = label、抜粋があれば引き継ぐ) として入れ、リンクする
 *      - タイトル = 記事タイトル (無ければ path)、summary = 記事 path、view / edit = clearance、internal
 *      - createdAt / updatedAt は記事の `articleUpdatedAt ?? publishedAt ?? createdAt` に合わせる
 *        (/dossiers は updatedAt 降順なので、今日の日付で 200 件超が先頭を占拠しないように)
 *      - `unresolved` (Asset 不在) と assetId の無い行はスキップ
 *   4. 出典が 1 つも無ければ作らない (必要になったら画面の「素材ドシエを作る」で)
 *
 * `Article.dossierId` は素の SQL で書く (`updatedAt` を進めない。編集中の人の楽観ロックを壊さず、
 * push の出力にも影響しないので dirty も立てない)。
 *
 * 書き込みは DIRECT_URL (postgres ロール / RLS バイパス)。既定は dry-run、--apply で書く。
 *
 * Usage:
 *   pnpm cli:backfill-article-dossiers                       # dry-run
 *   pnpm cli:backfill-article-dossiers --apply --owner <email>
 *   (--owner 省略時: admin が 1 人だけならその人)
 */

import "dotenv/config";
import { PrismaClient, type Prisma } from "@prisma/client";

if (!process.env.DIRECT_URL) {
  console.error("DIRECT_URL が未設定です (このスクリプトは RLS バイパス接続が必須)");
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ownerArg = (() => {
  const i = args.indexOf("--owner");
  return i >= 0 ? args[i + 1] : undefined;
})();

async function resolveOwner(): Promise<{ id: string; email: string }> {
  if (ownerArg) {
    const u = await prisma.user.findUnique({ where: { email: ownerArg }, select: { id: true, email: true } });
    if (!u) throw new Error(`--owner のユーザーが見つかりません: ${ownerArg}`);
    return u;
  }
  const admins = await prisma.user.findMany({ where: { role: "admin" }, select: { id: true, email: true } });
  if (admins.length !== 1) {
    throw new Error(`admin が ${admins.length} 人います。--owner <email> で所有者を指定してください`);
  }
  return admins[0];
}

function frontmatterDossierId(extra: Prisma.JsonValue): string | null {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return null;
  const d = (extra as Record<string, unknown>).dossier;
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const id = (d as Record<string, unknown>).id;
  return typeof id === "string" && id !== "" ? id : null;
}

async function main() {
  console.log(`記事の素材ドシエをバックフィル${APPLY ? "" : " (dry-run。書くには --apply)"}`);
  const owner = await resolveOwner();
  console.log(`所有者: ${owner.email}`);

  const articles = await prisma.article.findMany({
    orderBy: { path: "asc" },
    select: {
      id: true,
      shortId: true,
      path: true,
      title: true,
      dossierId: true,
      frontmatterExtra: true,
      publishedAt: true,
      articleUpdatedAt: true,
      createdAt: true,
      sources: {
        // RLS を通さない接続なので読みの側で絞る: 公開済み (applied ⇒ public) の出典だけを
        // internal / clearance 共有のドシエに写す。applied なのに非 public の行 (push 側が
        // blocked 扱いにするもの) は下位に降ろさない
        where: { status: "applied", classification: "public", assetId: { not: null } },
        orderBy: [{ sourceNo: "asc" }, { sortOrder: "asc" }],
        select: {
          assetId: true,
          label: true,
          excerpt: true,
          excerptType: true,
          excerptStart: true,
          excerptEnd: true,
          asset: { select: { title: true } },
        },
      },
    },
  });

  const stats = { skipped: 0, linked: 0, created: 0, items: 0, noSources: 0, fmMissing: 0 };

  for (const a of articles) {
    const label = `${a.shortId} ${a.path}`;
    if (a.dossierId) {
      stats.skipped++;
      continue;
    }

    // 2. 旧ワークフローのドシエが実在すればリンクだけ
    const fmId = frontmatterDossierId(a.frontmatterExtra);
    if (fmId) {
      const existing = await prisma.dossier.findUnique({ where: { id: fmId }, select: { id: true, kind: true } });
      if (existing && existing.kind !== "clips") {
        stats.linked++;
        console.log(`  [リンク] ${label} → 既存ドシエ ${fmId}`);
        if (APPLY) {
          await prisma.$executeRaw`UPDATE "Article" SET "dossierId" = ${fmId} WHERE "id" = ${a.id}`;
        }
        continue;
      }
      stats.fmMissing++;
      console.log(`  [注意] ${label}: frontmatter の dossier.id ${fmId} が実在しない。新規作成に回す`);
    }

    // 3. 出典から作る
    if (a.sources.length === 0) {
      stats.noSources++;
      continue;
    }
    const when = a.articleUpdatedAt ?? a.publishedAt ?? a.createdAt;
    stats.created++;
    stats.items += a.sources.length;
    console.log(`  [作成] ${label}: 出典 ${a.sources.length} 件 (${when.toISOString().slice(0, 10)})`);
    if (!APPLY) continue;

    await prisma.$transaction(async (tx) => {
      const dossier = await tx.dossier.create({
        data: {
          ownerId: owner.id,
          title: a.title || a.path,
          summary: `記事 ${a.path} の素材`,
          classification: "internal",
          viewMode: "clearance",
          editMode: "clearance",
          kind: "general",
          createdAt: when,
          updatedAt: when,
          // createMany で 1 文にする (create の配列だと出典の数だけ INSERT が往復する)
          items: {
            createMany: {
              data: a.sources.map((s, i) => ({
                kind: "asset_ref" as const,
                assetId: s.assetId,
                caption: s.label || s.asset?.title || "",
                excerpt: s.excerpt,
                excerptType: s.excerptType,
                excerptStart: s.excerptStart,
                excerptEnd: s.excerptEnd,
                sortOrder: i,
                createdAt: when,
                updatedAt: when,
              })),
            },
          },
        },
        select: { id: true },
      });
      await tx.$executeRaw`UPDATE "Article" SET "dossierId" = ${dossier.id} WHERE "id" = ${a.id}`;
    });
  }

  console.log("");
  console.log(
    [
      `記事 ${articles.length} 件`,
      `既にリンク済み ${stats.skipped}`,
      `既存ドシエにリンク ${stats.linked}`,
      `新規作成 ${stats.created} (アイテム ${stats.items})`,
      `出典なしで見送り ${stats.noSources}`,
      ...(stats.fmMissing ? [`frontmatter のドシエが実在せず ${stats.fmMissing}`] : []),
    ].join(" / ")
  );
  if (!APPLY) console.log("dry-run でした。書き込むには --apply");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
