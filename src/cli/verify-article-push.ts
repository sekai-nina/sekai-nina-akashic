/**
 * DB から組み立てた記事 Markdown と、リポジトリの実ファイルを突き合わせる。
 *
 * push (#46) は DB のカラムから frontmatter を丸ごと生成し直すので、取り込み →
 * 書き出しのどこかで値が落ちると **本番の記事 332 本を壊す**。往復テスト
 * (frontmatter.articles.test.ts) は parse → build の変換だけを見るが、ここは
 * 取り込み済みの DB を経由した本物の経路 (`renderArticleForPush`) で確かめる。
 *
 * 結果は 4 種に分けて報告する (判定は src/lib/articles/verify.ts):
 *   [一致]        バイト単位で同じ。push しても差分が出ない
 *   [正規化のみ]  値は同じでバイトが違う (引用符・キー順・日付のゼロ埋め等。
 *                 INTENTIONAL_NORMALIZATIONS 参照)。初回 push で一度だけ差分が出る
 *   [ref 追加]    値の差が「source[].ref が新たに生えた」だけ。url / label で照合して
 *                 applied になった行に ref が補完される (合意済み: #74)
 *   [値の差分]    上記以外。取りこぼしの疑いがあるので **1 件でも出たら push してはいけない**
 *
 * 併せて、push を拒否すべき記事 (非 public の applied / unresolved がある)、
 * DB にあってリポジトリに無い記事 (push で削除済みファイルが復活する)、
 * リポジトリにあって DB に無い記事 (未取り込み) も列挙する。
 * 値の差分・push 拒否・ファイル無しのいずれかがあれば exit 1。
 *
 * 接続は `renderArticleForPush` と同じ DATABASE_URL (app_runtime、RLS 越し)。
 * `Article` は非保護なので一覧も素の prisma で引ける。DIRECT_URL は使わない。
 *
 * Usage:
 *   pnpm cli:verify-article-push --dir <articles-dir>
 *   pnpm cli:verify-article-push --dir <articles-dir> --diff   # 差分の中身も出す
 */

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { articlesDirFromArgs, listArticleFiles } from "@/lib/articles/files";
import { parseArticle, toArticleColumns } from "@/lib/articles/frontmatter";
import { compareArticle, lineDiff, VERDICT_LABELS, type Verdict } from "@/lib/articles/verify";
import { prisma } from "@/lib/db";
import { renderArticleForPush } from "@/lib/domain/articles";

const args = process.argv.slice(2);
const SHOW_DIFF = args.includes("--diff");
const DIR = articlesDirFromArgs(args);

async function main() {
  if (!DIR) {
    console.error("記事ディレクトリを --dir か ARTICLES_DIR で指定してください");
    process.exit(1);
  }

  // 取り込み対象 (short_id あり) のファイルだけを「リポジトリ側」とみなす
  const inRepo = new Set<string>();
  for (const f of await listArticleFiles(DIR)) {
    const rel = relative(DIR, f);
    if (toArticleColumns(parseArticle(await readFile(f, "utf8")), rel).shortId !== "") inRepo.add(rel);
  }

  const articles = await prisma.article.findMany({
    select: { shortId: true, path: true },
    orderBy: { path: "asc" },
  });
  console.log(`DB の記事 ${articles.length} 件 / リポジトリの記事 ${inRepo.size} 件 (${DIR})`);

  const byVerdict: Record<Verdict, string[]> = { identical: [], normalized: [], ref_added: [], changed: [] };
  const missingFile: string[] = [];
  const blocked: string[] = [];
  const diffs: string[] = [];

  let done = 0;
  for (const { shortId, path } of articles) {
    done++;
    if (done % 50 === 0) console.log(`  ${done}/${articles.length}`);

    const rendered = await renderArticleForPush(shortId);
    if (!rendered) throw new Error(`renderArticleForPush が null を返した: ${shortId}`);
    if (!rendered.ok) {
      const nos = rendered.blockedSourceNos.map((n) => `^[${n ?? "-"}]`).join(" ");
      blocked.push(`${path}  非 public の applied/unresolved ${rendered.blockedSourceNos.length} 件 (${nos})`);
      continue;
    }
    if (!inRepo.has(path)) {
      missingFile.push(path);
      continue;
    }
    const fileRaw = await readFile(join(DIR, path), "utf8");
    const { verdict, notes } = compareArticle(fileRaw, rendered.markdown, path);
    byVerdict[verdict].push(notes.length ? `${path}  ${notes.join(" / ")}` : path);
    if (SHOW_DIFF && verdict !== "identical") {
      diffs.push(`=== ${path} [${VERDICT_LABELS[verdict]}] ===\n${lineDiff(fileRaw, rendered.markdown)}`);
    }
  }

  const inDb = new Set(articles.map((a) => a.path));
  const notImported = [...inRepo].filter((p) => !inDb.has(p)).sort();

  console.log("\n=== 結果 ===");
  for (const v of ["identical", "normalized", "ref_added", "changed"] as const) {
    console.log(`  ${VERDICT_LABELS[v].padEnd(10)} ${byVerdict[v].length}`);
  }
  console.log(`  ${"push 拒否".padEnd(10)} ${blocked.length}`);
  console.log(`  ${"ファイル無し".padEnd(10)} ${missingFile.length}`);
  console.log(`  ${"未取り込み".padEnd(10)} ${notImported.length}`);

  const section = (title: string, lines: string[]) => {
    if (!lines.length) return;
    console.log(`\n--- ${title} (${lines.length} 件) ---`);
    for (const l of lines) console.log(`  ${l}`);
  };
  section("値の差分 — push 前に必ず原因を確認する", byVerdict.changed);
  section("push 拒否 — 非 public の applied/unresolved がある", blocked);
  section("DB にあってリポジトリに無い — push すると削除済みファイルが復活する", missingFile);
  section("ref 追加", byVerdict.ref_added);
  section("正規化のみ", byVerdict.normalized);
  section("リポジトリにあって DB に無い (未取り込み)", notImported);

  if (diffs.length) {
    console.log("\n=== 差分 ===");
    for (const d of diffs) console.log(`\n${d}`);
  }

  if (byVerdict.changed.length || blocked.length || missingFile.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("ERR", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
