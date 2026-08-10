/**
 * 記事 (世界新奈) の取り込み — sekai-nina/sekai-nina-public の Markdown を Article/ArticleSource へ。
 *
 * 記事は short_id で冪等 upsert する。ArticleSource は記事ごとに全置換する
 * (frontmatter の source[] が正なので、差分マージより全置換の方が単純で壊れにくい)。
 *
 * source[] の解決規則:
 *   1. ref あり → Asset が実在すれば applied、実在しなければ unresolved (元 ref を originalRef に保持)
 *   2. ref なし・url あり → SourceRecord.url 一致で applied、無ければ unresolved
 *   3. ref なし・label のみ → Asset.title 完全一致で applied、無ければ unresolved
 *   --create-missing を付けると 2/3 の未解決分について Asset を新規作成して applied にする。
 *
 * 書き込みは DIRECT_URL (postgres ロール / RLS バイパス)。
 * 既定は dry-run。実際に書き込むには --apply が要る。
 *
 * Usage:
 *   pnpm cli:import-articles --dir <articles-dir>            # dry-run
 *   pnpm cli:import-articles --dir <articles-dir> --apply
 *   pnpm cli:import-articles --dir <articles-dir> --apply --create-missing
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  PrismaClient,
  ArticleType,
  ArticleSourceStatus,
  AssetKind,
  AssetStatus,
  SourceKind,
  SourceType,
} from "@prisma/client";
import "dotenv/config";

import {
  parseArticle,
  parseFrontmatterDate as toDate,
  type ArticleSourceEntry,
} from "@/lib/articles/frontmatter";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const CREATE_MISSING = args.includes("--create-missing");
const DIR = (() => {
  const i = args.indexOf("--dir");
  return i !== -1 ? args[i + 1] : process.env.ARTICLES_DIR;
})();

/** 記事ではない Markdown (リポジトリ直下の README 等) */
const NON_ARTICLE = new Set(["README.md"]);

const ARTICLE_TYPES = new Set<string>(Object.values(ArticleType));

async function walk(dir: string, root: string, out: string[] = []): Promise<string[]> {
  for (const name of await readdir(dir)) {
    if (name.startsWith(".") || name === "_templates") continue;
    const p = join(dir, name);
    if ((await stat(p)).isDirectory()) await walk(p, root, out);
    else if (name.endsWith(".md") && !NON_ARTICLE.has(relative(root, p))) out.push(p);
  }
  return out;
}

function toBool(v: unknown): boolean {
  return v === true || v === "true";
}

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toType(v: unknown): ArticleType | null {
  if (v == null) return null;
  let s = String(v).trim();
  // Astro 側の transform に合わせる (fact / state は attribute に寄せる)
  if (s === "fact" || s === "state") s = "attribute";
  return ARTICLE_TYPES.has(s) ? (s as ArticleType) : null;
}

type ParsedFile = {
  path: string;
  shortId: string;
  fm: Record<string, unknown>;
  extra: Record<string, unknown>;
  sources: ArticleSourceEntry[];
  body: string;
};

type Resolution = {
  entry: ArticleSourceEntry;
  assetId: string | null;
  status: ArticleSourceStatus;
  /** --create-missing で新規作成する対象か */
  needsCreate: boolean;
};

async function main() {
  if (!DIR) {
    console.error("記事ディレクトリを --dir か ARTICLES_DIR で指定してください");
    process.exit(1);
  }

  const files = await walk(DIR, DIR);
  console.log(`Markdown ${files.length} 件を検出 (${DIR})`);

  // --- 1. 全ファイルをパースする -------------------------------------------
  const parsed: ParsedFile[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const { frontmatter, extra, sources, body } = parseArticle(await readFile(f, "utf8"));
    const shortId = frontmatter.short_id == null ? "" : String(frontmatter.short_id).trim();
    if (shortId === "") {
      skipped.push(relative(DIR, f));
      continue;
    }
    parsed.push({ path: relative(DIR, f), shortId, fm: frontmatter, extra, sources, body });
  }
  if (skipped.length) {
    console.log(`short_id が無いためスキップ: ${skipped.length} 件`);
    for (const s of skipped) console.log(`  - ${s}`);
  }

  // --- 2. 照合対象を一括で引く ---------------------------------------------
  const allSources = parsed.flatMap((p) => p.sources);
  const refs = [...new Set(allSources.map((s) => s.ref).filter(Boolean) as string[])];
  const urls = [...new Set(allSources.filter((s) => !s.ref && s.url).map((s) => s.url!) )];
  const labels = [...new Set(allSources.filter((s) => !s.ref && !s.url && s.label).map((s) => s.label!))];

  const [assetsByRef, srcByUrl, assetsByTitle] = await Promise.all([
    prisma.asset.findMany({ where: { id: { in: refs } }, select: { id: true } }),
    prisma.sourceRecord.findMany({
      where: { url: { in: urls } },
      select: { url: true, assetId: true },
    }),
    prisma.asset.findMany({ where: { title: { in: labels } }, select: { id: true, title: true } }),
  ]);

  const refSet = new Set(assetsByRef.map((a) => a.id));
  const urlMap = new Map(srcByUrl.filter((s) => s.url).map((s) => [s.url!, s.assetId]));
  const titleMap = new Map(assetsByTitle.map((a) => [a.title, a.id]));

  // --- 3. 解決する -----------------------------------------------------------
  const resolve = (e: ArticleSourceEntry): Resolution => {
    if (e.ref) {
      return refSet.has(e.ref)
        ? { entry: e, assetId: e.ref, status: ArticleSourceStatus.applied, needsCreate: false }
        : { entry: e, assetId: null, status: ArticleSourceStatus.unresolved, needsCreate: false };
    }
    if (e.url) {
      const hit = urlMap.get(e.url);
      if (hit) return { entry: e, assetId: hit, status: ArticleSourceStatus.applied, needsCreate: false };
      return { entry: e, assetId: null, status: ArticleSourceStatus.unresolved, needsCreate: true };
    }
    if (e.label) {
      const hit = titleMap.get(e.label);
      if (hit) return { entry: e, assetId: hit, status: ArticleSourceStatus.applied, needsCreate: false };
      return { entry: e, assetId: null, status: ArticleSourceStatus.unresolved, needsCreate: true };
    }
    return { entry: e, assetId: null, status: ArticleSourceStatus.unresolved, needsCreate: false };
  };

  const stats = { applied: 0, unresolved: 0, dangling: 0, created: 0 };
  const plan = parsed.map((p) => {
    const resolutions = p.sources.map(resolve);
    for (const r of resolutions) {
      if (r.status === ArticleSourceStatus.applied) stats.applied++;
      else {
        stats.unresolved++;
        if (r.entry.ref) stats.dangling++;
      }
    }
    return { file: p, resolutions };
  });

  console.log("\n=== 解決結果 ===");
  console.log(`記事              ${parsed.length}`);
  console.log(`source エントリ   ${allSources.length}`);
  console.log(`  applied         ${stats.applied}`);
  console.log(`  unresolved      ${stats.unresolved} (うち dangling ref ${stats.dangling})`);
  console.log(`  新規作成候補    ${plan.flatMap((p) => p.resolutions).filter((r) => r.needsCreate).length}`);

  if (!APPLY) {
    console.log("\ndry-run のため書き込みはしていません。--apply を付けると反映します");
    return;
  }

  // --- 4. 書き込み ----------------------------------------------------------
  console.log("\n=== 書き込み ===");
  let done = 0;
  for (const { file, resolutions } of plan) {
    // --create-missing: 未解決のうち手がかりのあるものを Asset として起こす
    for (const r of resolutions) {
      if (!r.needsCreate || !CREATE_MISSING) continue;
      const e = r.entry;

      // 照合マップは走査開始前に作るので、同じ run 内で同一 url/label が 2 度出ると
      // 重複 Asset を作ってしまう。作成のたびにマップを更新して再照合する。
      const hit = e.url ? urlMap.get(e.url) : e.label ? titleMap.get(e.label) : undefined;
      if (hit) {
        r.assetId = hit;
        r.status = ArticleSourceStatus.applied;
        continue;
      }

      const asset = await prisma.asset.create({
        data: {
          kind: AssetKind.other,
          title: e.label ?? e.url ?? "",
          status: AssetStatus.inbox,
          sourceType: SourceType.import,
          canonicalDate: toDate(e.date),
          ...(e.url
            ? {
                sourceRecords: {
                  create: { sourceKind: SourceKind.url, url: e.url, title: e.label ?? "" },
                },
              }
            : {}),
        },
        select: { id: true },
      });
      if (e.url) urlMap.set(e.url, asset.id);
      if (e.label) titleMap.set(e.label, asset.id);
      r.assetId = asset.id;
      r.status = ArticleSourceStatus.applied;
      stats.created++;
    }

    const fm = file.fm;
    const data = {
      shortId: file.shortId,
      path: file.path,
      slug: fm.slug == null ? null : String(fm.slug),
      title: fm.title == null ? "" : String(fm.title),
      type: toType(fm.type),
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      body: file.body,
      date: toDate(fm.date),
      dateDisplay: fm.date_display == null ? null : String(fm.date_display),
      dateMode: fm.date_mode == null ? null : String(fm.date_mode),
      publishedAt: toDate(fm.published_at),
      articleUpdatedAt: toDate(fm.updated_at),
      draft: toBool(fm.draft),
      unlisted: toBool(fm.unlisted),
      ongoing: toBool(fm.ongoing),
      lat: toNum(fm.lat),
      lng: toNum(fm.lng),
      frontmatterExtra: file.extra as object,
      dirty: false,
      lastSyncedAt: new Date(),
    };

    const article = await prisma.article.upsert({
      where: { shortId: file.shortId },
      create: data,
      update: data,
      select: { id: true },
    });

    // frontmatter 由来の出典だけを全置換する。
    //
    // pending は akashic 側で付けた紐づけで、frontmatter の source[] には
    // 載っていない。抜粋 (excerpt / excerptStart / excerptEnd / note) は
    // DB にしか無く Markdown から再生成できないので、巻き込んで消すと
    // 復旧できないデータロスになる。
    //
    // 削除と再作成は 1 トランザクションにまとめる。途中で落ちると
    // 出典が消えたまま残るため。
    const replaced = resolutions.map((r, i) => ({
      articleId: article.id,
      assetId: r.assetId,
      status: r.status,
      sourceNo: r.entry.id ?? null,
      label: r.entry.label ?? "",
      url: r.entry.url ?? null,
      date: toDate(r.entry.date),
      originalRef: r.status === ArticleSourceStatus.unresolved ? (r.entry.ref ?? null) : null,
      sortOrder: i,
    }));
    await prisma.$transaction([
      prisma.articleSource.deleteMany({
        where: { articleId: article.id, status: { not: ArticleSourceStatus.pending } },
      }),
      ...(replaced.length ? [prisma.articleSource.createMany({ data: replaced })] : []),
    ]);

    done++;
    if (done % 50 === 0) console.log(`  ${done}/${plan.length}`);
  }

  console.log(`\n完了: 記事 ${done} 件 / Asset 新規作成 ${stats.created} 件`);
}

main()
  .catch((e) => {
    console.error("ERR", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
