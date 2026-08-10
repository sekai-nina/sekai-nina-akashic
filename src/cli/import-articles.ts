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
  ArticleSourceStatus,
  ArticleType,
  AssetKind,
  AssetStatus,
  SourceKind,
  SourceType,
} from "@prisma/client";
import "dotenv/config";

import {
  parseArticle,
  parseFrontmatterDate,
  toArticleColumns,
  type ArticleColumns,
  type ArticleSourceEntry,
} from "@/lib/articles/frontmatter";
import { hasChanged } from "@/lib/articles/changes";
import {
  addCandidate,
  pickCandidate,
  FAIL_REASON_LABELS,
  type Candidate,
  type FailReason,
} from "@/lib/articles/matching";

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

async function walk(dir: string, root: string, out: string[] = []): Promise<string[]> {
  for (const name of await readdir(dir)) {
    if (name.startsWith(".") || name === "_templates") continue;
    const p = join(dir, name);
    if ((await stat(p)).isDirectory()) await walk(p, root, out);
    else if (name.endsWith(".md") && !NON_ARTICLE.has(relative(root, p))) out.push(p);
  }
  return out;
}

/** カラムに落とした 1 記事。sources は必ず入る (toArticleColumns が詰める) */
type ParsedFile = ArticleColumns;

type Resolution = {
  entry: ArticleSourceEntry;
  assetId: string | null;
  status: ArticleSourceStatus;
  /** --create-missing で新規作成する対象か */
  needsCreate: boolean;
  reason?: FailReason;
  /** ambiguous のときの候補数 (ログ用) */
  candidates?: number;
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
  /** 取り込みを止めるほどではないが人が見るべき警告 */
  const warnings: string[] = [];

  for (const f of files) {
    const parsedArticle = parseArticle(await readFile(f, "utf8"));
    const cols = toArticleColumns(parsedArticle, relative(DIR, f));
    if (cols.shortId === "") {
      skipped.push(cols.path);
      continue;
    }
    // type が enum 外だと null になり、KNOWN キーなので frontmatterExtra にも
    // 退避されない = push でキーごと消える。黙って捨てずに知らせる
    const rawType = parsedArticle.frontmatter.type;
    if (rawType != null && cols.type == null) {
      warnings.push(`${cols.path}: type: ${String(rawType)} は ArticleType に無いので取り込まれない`);
    }
    parsed.push(cols);
  }
  if (skipped.length) {
    console.log(`short_id が無いためスキップ: ${skipped.length} 件`);
    for (const s of skipped) console.log(`  - ${s}`);
  }

  // 同じ short_id を持つファイルは後勝ちで上書きされ、片方が黙って消える
  const byShortId = new Map<string, string[]>();
  for (const p of parsed) {
    const list = byShortId.get(p.shortId);
    if (list) list.push(p.path);
    else byShortId.set(p.shortId, [p.path]);
  }
  const dupShortIds = [...byShortId].filter(([, v]) => v.length > 1);
  if (dupShortIds.length) {
    console.error(`\n**short_id が重複しています (${dupShortIds.length} 組)**`);
    for (const [id, paths] of dupShortIds) console.error(`  ${id}: ${paths.join(" / ")}`);
    console.error("後勝ちで片方が消えるため中断します。short_id を振り直してください");
    process.exitCode = 1;
    return;
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
      select: { url: true, assetId: true, asset: { select: { canonicalDate: true } } },
    }),
    prisma.asset.findMany({
      where: { title: { in: labels } },
      select: { id: true, title: true, canonicalDate: true },
    }),
  ]);

  const refSet = new Set(assetsByRef.map((a) => a.id));

  // **候補は配列で持つ。** Asset.title にも SourceRecord.url にも一意制約が無いので、
  // 後勝ちの Map にすると無関係な Asset に applied として紐づく
  const urlMap = new Map<string, Candidate[]>();
  for (const s of srcByUrl) {
    if (s.url) addCandidate(urlMap, s.url, { id: s.assetId, date: s.asset?.canonicalDate ?? null });
  }
  const titleMap = new Map<string, Candidate[]>();
  for (const a of assetsByTitle) addCandidate(titleMap, a.title, { id: a.id, date: a.canonicalDate });

  // --- 3. 解決する -----------------------------------------------------------

  const resolve = (e: ArticleSourceEntry): Resolution => {
    const applied = (assetId: string): Resolution => ({
      entry: e,
      assetId,
      status: ArticleSourceStatus.applied,
      needsCreate: false,
    });
    const failed = (reason: FailReason, needsCreate = false, candidates?: number): Resolution => ({
      entry: e,
      assetId: null,
      status: ArticleSourceStatus.unresolved,
      needsCreate,
      reason,
      candidates,
    });

    if (e.ref) {
      return refSet.has(e.ref) ? applied(e.ref) : failed("dangling");
    }

    const date = parseFrontmatterDate(e.date);

    if (e.url) {
      // url は完全一致なので日付を拒否権にしない (放送日と配信日のように
      // 正当にずれることがあり、落とすと永久に unresolved になる)
      const { id, reason, candidates } = pickCandidate(urlMap.get(e.url), date);
      if (id) return applied(id);
      // 候補が複数ある/日付が食い違う場合に新しく作ると、同じものを二重に増やす
      return failed(reason!, reason === "not_found", candidates);
    }
    if (e.label) {
      const { id, reason, candidates } = pickCandidate(titleMap.get(e.label), date, {
        strictDate: true,
      });
      if (id) return applied(id);
      return failed(reason!, reason === "not_found", candidates);
    }
    return failed("no_clue");
  };

  // 既存の記事。path の衝突検出・削除検出・差分スキップに使う
  const existing = await prisma.article.findMany({
    select: {
      id: true, shortId: true, path: true, slug: true, title: true, type: true, tags: true,
      body: true, date: true, dateDisplay: true, dateMode: true, publishedAt: true,
      articleUpdatedAt: true, draft: true, unlisted: true, ongoing: true, lat: true, lng: true,
      frontmatterExtra: true,
      dirty: true, lastSyncedAt: true,
      sources: {
        where: { status: { not: ArticleSourceStatus.pending } },
        orderBy: { sortOrder: "asc" },
        select: {
          assetId: true, status: true, sourceNo: true, label: true, url: true,
          date: true, originalRef: true, sortOrder: true,
        },
      },
    },
  });
  const existingByShortId = new Map(existing.map((a) => [a.shortId, a]));

  // path は @@unique。別の short_id が同じ path を持つと upsert が P2002 で落ち、
  // 途中まで書き込んだ中途半端な状態で止まる
  const pathOwner = new Map(existing.map((a) => [a.path, a.shortId]));
  const pathConflicts = parsed.filter((p) => {
    const owner = pathOwner.get(p.path);
    return owner != null && owner !== p.shortId;
  });
  if (pathConflicts.length) {
    console.error(`\n**path が既存の別記事と衝突しています (${pathConflicts.length} 件)**`);
    for (const p of pathConflicts) {
      console.error(`  ${p.path}: 既存 short_id=${pathOwner.get(p.path)} / 今回 short_id=${p.shortId}`);
    }
    console.error("upsert が P2002 で中断するため先に止めます");
    process.exitCode = 1;
    return;
  }

  // リポジトリから消えた記事。ArticleSource は全置換なのに記事だけ追記のみだと
  // 非対称なので、少なくとも検出して知らせる
  const seenShortIds = new Set(parsed.map((p) => p.shortId));
  const gone = existing.filter((a) => !seenShortIds.has(a.shortId));

  const stats = { applied: 0, unresolved: 0, dangling: 0, created: 0, skipped: 0 };
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
  console.log(`  unresolved      ${stats.unresolved}`);
  const byReason = new Map<FailReason, { r: Resolution; path: string }[]>();
  for (const { file, resolutions } of plan) {
    for (const r of resolutions) {
      if (!r.reason) continue;
      const list = byReason.get(r.reason);
      if (list) list.push({ r, path: file.path });
      else byReason.set(r.reason, [{ r, path: file.path }]);
    }
  }
  for (const [reason, list] of byReason) {
    console.log(`    ${FAIL_REASON_LABELS[reason].padEnd(28)} ${list.length}`);
  }
  console.log(`  新規作成候補    ${plan.flatMap((p) => p.resolutions).filter((r) => r.needsCreate).length}`);

  // 誤って別の Asset に紐づくのを防いだぶんは、人が直せるように必ず列挙する
  for (const reason of ["ambiguous", "date_mismatch"] as const) {
    const list = byReason.get(reason) ?? [];
    if (!list.length) continue;
    console.log(`\n--- ${FAIL_REASON_LABELS[reason]} (${list.length} 件) ---`);
    for (const { r, path } of list) {
      const clue = r.entry.url ?? r.entry.label ?? "";
      const extra = r.candidates ? ` [候補 ${r.candidates} 件]` : "";
      console.log(`  ${path}  ^[${r.entry.id ?? "-"}] ${clue.slice(0, 60)}${extra}`);
    }
  }

  if (warnings.length) {
    console.log(`\n--- 警告 (${warnings.length} 件) ---`);
    for (const w of warnings) console.log(`  ${w}`);
  }

  if (gone.length) {
    console.log(`\n--- リポジトリから消えた記事 (${gone.length} 件) ---`);
    for (const a of gone) console.log(`  ${a.path} (short_id=${a.shortId})`);
    console.log("  自動削除はしない。不要なら Prisma Studio で消すか、移動なら path を合わせる");
  }

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
      const date = parseFrontmatterDate(e.date);
      const again = e.url
        ? pickCandidate(urlMap.get(e.url), date)
        : e.label
          ? pickCandidate(titleMap.get(e.label), date, { strictDate: true })
          : { id: null };
      if (again.id) {
        r.assetId = again.id;
        r.status = ArticleSourceStatus.applied;
        r.reason = undefined;
        continue;
      }

      const asset = await prisma.asset.create({
        data: {
          kind: AssetKind.other,
          title: e.label ?? e.url ?? "",
          status: AssetStatus.inbox,
          sourceType: SourceType.import,
          canonicalDate: date,
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
      if (e.url) addCandidate(urlMap, e.url, { id: asset.id, date });
      if (e.label) addCandidate(titleMap, e.label, { id: asset.id, date });
      r.assetId = asset.id;
      r.status = ArticleSourceStatus.applied;
      stats.created++;
    }

    const { sources: _sources, ...cols } = file;

    // frontmatter 由来の出典。DB に入れる形に揃える (差分判定にも使う)
    const wanted = resolutions.map((r, i) => ({
      assetId: r.assetId,
      status: r.status,
      sourceNo: r.entry.id ?? null,
      label: r.entry.label ?? "",
      url: r.entry.url ?? null,
      date: parseFrontmatterDate(r.entry.date),
      originalRef: r.status === ArticleSourceStatus.unresolved ? (r.entry.ref ?? null) : null,
      sortOrder: i,
    }));

    // **変わっていない記事は触らない。**
    // 332 件ぶんの upsert + ArticleSource 全置換を毎回流すと、Supabase の
    // egress と接続時間を無駄に食う (過去に走りっぱなしのスクリプトで
    // 70GB 超過の事故がある)
    const prev = existingByShortId.get(file.shortId);
    if (prev && !hasChanged(prev, cols, wanted)) {
      // 内容は同じでも「取り込んだ」事実は残す。dirty / lastSyncedAt は
      // frontmatter 由来ではないので hasChanged の比較対象に入っておらず、
      // ここで更新しないと push 済みの記事が dirty のまま残り、
      // 一覧の「未 push N 本」が恒久的に嘘をつく
      if (prev.dirty || prev.lastSyncedAt == null) {
        await prisma.article.update({
          where: { id: prev.id },
          data: { dirty: false, lastSyncedAt: new Date() },
        });
      }
      stats.skipped++;
      done++;
      continue;
    }

    const data = {
      ...cols,
      tags: cols.tags as object,
      frontmatterExtra: cols.frontmatterExtra as object,
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
    const replaced = wanted.map((w) => ({ ...w, articleId: article.id }));
    await prisma.$transaction([
      prisma.articleSource.deleteMany({
        where: { articleId: article.id, status: { not: ArticleSourceStatus.pending } },
      }),
      ...(replaced.length ? [prisma.articleSource.createMany({ data: replaced })] : []),
    ]);

    done++;
    if (done % 50 === 0) console.log(`  ${done}/${plan.length}`);
  }

  console.log(
    `\n完了: 記事 ${done} 件 (うち変更なしでスキップ ${stats.skipped} 件) / Asset 新規作成 ${stats.created} 件`,
  );
}

main()
  .catch((e) => {
    console.error("ERR", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
