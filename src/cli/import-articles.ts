/**
 * 記事 (世界新奈) の取り込み — sekai-nina/sekai-nina-public の Markdown を Article/ArticleSource へ。
 *
 * 記事は short_id で冪等 upsert する。ArticleSource は記事ごとに全置換する
 * (frontmatter の source[] が正なので、差分マージより全置換の方が単純で壊れにくい)。
 *
 * source[] の解決規則:
 *   1. ref あり → Asset が実在すれば applied、実在しなければ unresolved
 *   2. ref なし・url あり → SourceRecord.url 一致で applied、無ければ unresolved
 *   3. ref なし・label のみ → Asset.title 完全一致で applied、無ければ unresolved
 *   --create-missing を付けると 2/3 の未解決分について Asset を新規作成して applied にする。
 *   元ファイルの ref は status に依らず originalRef に保持する (push 時の ref は assetId ?? originalRef)。
 *   frontmatter 由来の行は公開リポジトリに載っている内容なので classification は public
 *   (src/lib/articles/frontmatter.ts の toArticleSourceRow)。
 *
 * push (#46) との関係:
 *   - `githubSha` にファイルの git blob SHA を保存する。push はこれと GitHub 側の tree を
 *     突き合わせて「取り込んだ後に上流が変わっていないか」を判定する
 *   - `dirty` は「DB から組み立てた Markdown ≠ ファイル」で立てる (dirtyAfterImport)。
 *     値は同じでも引用符やキー順が違えば push で差分が出るので、取り込み直後に
 *     dirty になる記事がある (初回は全件)。値の差分 (取りこぼしの疑い) は dirty にせず警告する
 *   - **akashic で編集済み (`editedAt` が非 null) かつファイルが前回から変わっていない
 *     (blob SHA と path が同じ) 記事はスキップする** (DB 側の未 push 編集をファイルで上書きしない)。
 *     `dirty` ではなく `editedAt` で見るのは、正規化だけの dirty (取り込み直後) まで守ると
 *     --create-missing や照合のやり直しが push まで効かなくなるため (#89)。ファイルが変わって
 *     いれば上流が新しいので上書きし、akashic の編集を捨てた記事は最後に一覧で知らせる。
 *     スキップしなかった記事は `editedAt` を null に戻す (上書き後は akashic 側の編集が無い)
 *   - `--apply` は checkout が origin/main と一致しない・--dir がトップレベルでないと止まる
 *     (pull し忘れで DB が巻き戻る事故の防止)。承知の上で進めるなら --allow-stale
 *
 * 書き込みは DIRECT_URL (postgres ロール / RLS バイパス)。
 * 既定は dry-run。実際に書き込むには --apply が要る。
 *
 * Usage:
 *   pnpm cli:import-articles --dir <articles-dir>            # dry-run
 *   pnpm cli:import-articles --dir <articles-dir> --apply
 *   pnpm cli:import-articles --dir <articles-dir> --apply --create-missing
 *   pnpm cli:import-articles --dir <articles-dir> --apply --allow-stale
 */

import { readFile } from "node:fs/promises";
import { relative } from "node:path";
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
  toArticleSourceRow,
  type ArticleColumns,
  type ArticleSourceEntry,
} from "@/lib/articles/frontmatter";
import { hasChanged } from "@/lib/articles/changes";
import { articlesDirFromArgs, compareCheckoutWithRemote, listArticleFiles } from "@/lib/articles/files";
import { dirtyAfterImport } from "@/lib/articles/verify";
import { gitBlobSha } from "@/lib/github/blob";
import {
  addCandidate,
  pickCandidate,
  FAIL_REASON_LABELS,
  type Candidate,
  type FailReason,
} from "@/lib/articles/matching";
import { jstDayString } from "@/lib/utils";

// datasources.url は undefined でも型エラーにならず、schema の env("DATABASE_URL") に
// 無言でフォールバックする。それだと Asset / SourceRecord / ArticleSource が RLS で 0 行になり、
// 全部 unresolved として Article だけ書き換わる (githubSha / dirty の唯一の生成元なので致命的)
if (!process.env.DIRECT_URL) {
  console.error("DIRECT_URL が未設定です (このスクリプトは RLS バイパス接続が必須)");
  process.exit(1);
}

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const CREATE_MISSING = args.includes("--create-missing");
const ALLOW_STALE = args.includes("--allow-stale");
const DIR = articlesDirFromArgs(args);

/** カラムに落とした 1 記事。sources は必ず入る (toArticleColumns が詰める) */
type ParsedFile = ArticleColumns & {
  /** ファイルの生の内容。dirty 判定 (DB の出力と突き合わせる) に使う */
  raw: string;
  /** ファイルの git blob SHA。`Article.githubSha` に入れる */
  blobSha: string;
};

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

  const files = await listArticleFiles(DIR);
  console.log(`Markdown ${files.length} 件を検出 (${DIR})`);

  // --- 1. 全ファイルをパースする -------------------------------------------
  const parsed: ParsedFile[] = [];
  const skipped: string[] = [];
  /** 取り込みを止めるほどではないが人が見るべき警告 */
  const warnings: string[] = [];

  for (const f of files) {
    // blob SHA はバイト列から計算する。"utf8" で読むと不正なバイトが U+FFFD に置き換わり、
    // GitHub 側の SHA と永久に一致しなくなる
    const bytes = await readFile(f);
    const raw = bytes.toString("utf8");
    const parsedArticle = parseArticle(raw);
    const cols = toArticleColumns(parsedArticle, relative(DIR, f));
    if (cols.shortId === "") {
      skipped.push(cols.path);
      continue;
    }
    // shortId は /articles/<shortId> の URL と wikilink の href に入るので文字種を縛る。
    // 検証しないと frontmatter 経由でパス区切りやクエリを差し込める
    if (!/^[A-Za-z0-9_-]+$/.test(cols.shortId)) {
      console.error(`  ✗ short_id に使えない文字が含まれています: ${JSON.stringify(cols.shortId)} (${cols.path})`);
      skipped.push(cols.path);
      continue;
    }
    // type が enum 外だと null になり、KNOWN キーなので frontmatterExtra にも
    // 退避されない = push でキーごと消える。黙って捨てずに知らせる
    const rawType = parsedArticle.frontmatter.type;
    if (rawType != null && cols.type == null) {
      warnings.push(`${cols.path}: type: ${String(rawType)} は ArticleType に無いので取り込まれない`);
    }
    parsed.push({ ...cols, raw, blobSha: gitBlobSha(bytes) });
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
      dirty: true, lastSyncedAt: true, githubSha: true, editedAt: true,
      sources: {
        where: { status: { not: ArticleSourceStatus.pending } },
        orderBy: { sortOrder: "asc" },
        select: {
          assetId: true, status: true, classification: true, sourceNo: true, label: true,
          url: true, date: true, originalRef: true, sortOrder: true,
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

  const stats = { applied: 0, unresolved: 0, dangling: 0, created: 0, skipped: 0, preserved: 0, dirty: 0 };
  /** 値の差分 (取りこぼしの疑い) があり dirty にしなかった記事 */
  const lossy: string[] = [];
  /** akashic で編集済み (未 push) だったのに、上流が変わっていたのでファイルで上書きした記事 */
  const overwritten: string[] = [];

  /**
   * DB に akashic の未 push 編集があり (`editedAt` が非 null)、ファイルは取り込んだ時点から
   * 変わっていない (blob SHA が同じ、path も同じ) → 上流に新しい情報は無い。ファイルで
   * 上書きすると akashic 側の編集が消えるので残す。path も見るのは、内容そのままのリネームを
   * スキップすると DB が旧 path のまま残り、push が deleted_upstream で衝突し続けるため。
   * `dirty` は見ない: 正規化だけの dirty はファイルで上書きしても何も失わない
   */
  const preserve = (file: ParsedFile) => {
    const prev = existingByShortId.get(file.shortId);
    return prev != null && prev.editedAt != null && prev.githubSha === file.blobSha && prev.path === file.path;
  };

  /**
   * 取り込み後の dirty。resolutions は --create-missing で書き込み中に変わるので、
   * 書き込む直前 (と dry-run の見積もり) で都度呼ぶ
   */
  const decideDirty = (file: ParsedFile, resolutions: Resolution[]) => {
    const { sources: _sources, raw, blobSha: _sha, ...cols } = file;
    const wanted = resolutions.map((r, i) => toArticleSourceRow(r.entry, r, i));
    return { wanted, decision: dirtyAfterImport(raw, cols, wanted) };
  };
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

  // 同じ Asset に日付違いのエントリが集まっていないか。
  // 候補の canonicalDate が null だと照合では否定できないため、ここで拾う。
  // 番組の前後編のように正当な場合もあるので **状態は変えず報告だけする**
  const dateClashes: string[] = [];
  for (const { file, resolutions } of plan) {
    const byAsset = new Map<string, { no?: number; day: string }[]>();
    for (const r of resolutions) {
      if (!r.assetId) continue;
      const d = parseFrontmatterDate(r.entry.date);
      if (!d) continue;
      const list = byAsset.get(r.assetId);
      const item = { no: r.entry.id, day: jstDayString(d) };
      if (list) list.push(item);
      else byAsset.set(r.assetId, [item]);
    }
    for (const [assetId, list] of byAsset) {
      if (list.length < 2) continue;
      if (new Set(list.map((x) => x.day)).size < 2) continue;
      dateClashes.push(
        `${file.path}  ${list.map((x) => `^[${x.no ?? "-"}]=${x.day}`).join(" ")}  asset=${assetId}`,
      );
    }
  }
  if (dateClashes.length) {
    console.log(`\n--- 同一 Asset に日付違いで紐づいている (${dateClashes.length} 件) ---`);
    for (const c of dateClashes) console.log(`  ${c}`);
    console.log("  番組の前後編なら正常。別の収録なら Asset を分ける必要がある");
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

  // 古い checkout から取り込むと、akashic から push 済みの内容が DB 上で巻き戻る
  // (githubSha も古い blob になり、次の push で全件が衝突扱いになる)。
  // dry-run でも同じ検査をして知らせ、--apply では止める
  const checkoutProblems: string[] = [];
  try {
    const { head, remote, upToDate, isTopLevel, modified } = await compareCheckoutWithRemote(DIR);
    if (modified.length) {
      console.log(`\n--- 未コミットの変更があるファイル (${modified.length} 件) — 取り込むと push で衝突扱いになる ---`);
      for (const m of modified) console.log(`  ${m}`);
    }
    if (!isTopLevel) {
      checkoutProblems.push("--dir がリポジトリのトップレベルではありません (path がリポジトリ相対にならず、push で全件が衝突扱いになる)");
    }
    if (!upToDate) {
      checkoutProblems.push(
        `checkout が origin/main と一致しません (HEAD ${head.slice(0, 7)} / origin/main ${remote.slice(0, 7)})。pull してから取り込んでください`,
      );
    }
  } catch (e) {
    checkoutProblems.push(
      `checkout と origin/main の比較ができません: ${e instanceof Error ? e.message : String(e)} (--dir は sekai-nina-public の git checkout を指す)`,
    );
  }
  if (checkoutProblems.length) {
    console.error(`\n--- checkout の問題 (${checkoutProblems.length} 件) ---`);
    for (const p of checkoutProblems) console.error(`  ${p}`);
    if (APPLY && !ALLOW_STALE) {
      console.error("--apply を中断します。承知の上で進めるなら --allow-stale");
      process.exitCode = 1;
      return;
    }
    if (APPLY) console.error("--allow-stale のため続行します");
  }

  if (!APPLY) {
    // 取り込み後に push 待ち (dirty) になる記事の見積もり。--apply と同じく preserved
    // ガードを通す。--create-missing の分はまだ Asset が無いので ref が補完されず、
    // 実際より少なめに出ることがある
    let willDirty = 0;
    let willPreserve = 0;
    const willLossy: string[] = [];
    for (const { file, resolutions } of plan) {
      if (preserve(file)) {
        willPreserve++;
        continue;
      }
      const { decision } = decideDirty(file, resolutions);
      if (decision.dirty) willDirty++;
      else if (decision.verdict === "changed") willLossy.push(`${file.path}  ${decision.notes.join(" / ")}`);
    }
    console.log(`\n取り込み後に push 待ち (dirty) になる記事: ${willDirty} 件 / akashic の未 push 編集を残してスキップ: ${willPreserve} 件`);
    if (willLossy.length) {
      console.log(`--- 値の差分があり dirty にしない (${willLossy.length} 件) — push すると値が消えるので原因を確認する ---`);
      for (const l of willLossy) console.log(`  ${l}`);
    }
    console.log("\ndry-run のため書き込みはしていません。--apply を付けると反映します");
    return;
  }

  // --- 4. 書き込み ----------------------------------------------------------
  console.log("\n=== 書き込み ===");
  let done = 0;
  for (const { file, resolutions } of plan) {
    // ファイルが変わっていれば上流が新しいので、下で普通に上書きする (= 衝突は再取り込みで解消)
    if (preserve(file)) {
      stats.preserved++;
      done++;
      continue;
    }

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

    const { sources: _sources, raw: _raw, blobSha, ...cols } = file;

    // frontmatter 由来の出典。DB に入れる形に揃える (差分判定にも使う)。
    // 形は往復テストと共有する (取り込みだけ別の規則で動くのを防ぐ)
    const { wanted, decision } = decideDirty(file, resolutions);
    if (decision.dirty) stats.dirty++;
    else if (decision.verdict === "changed") lossy.push(`${file.path}  ${decision.notes.join(" / ")}`);

    // **変わっていない記事は触らない。**
    // 332 件ぶんの upsert + ArticleSource 全置換を毎回流すと、Supabase の
    // egress と接続時間を無駄に食う (過去に走りっぱなしのスクリプトで
    // 70GB 超過の事故がある)
    const prev = existingByShortId.get(file.shortId);
    if (prev && !hasChanged(prev, cols, wanted)) {
      // 内容は同じでも「取り込んだ」事実は残す。dirty / githubSha / lastSyncedAt は
      // frontmatter 由来ではないので hasChanged の比較対象に入っておらず、
      // ここで更新しないと push 済みの記事が dirty のまま残り、
      // 一覧の「未 push N 本」が恒久的に嘘をつく。
      // githubSha は、値が同じでもファイルのバイト列が変わっていれば (Obsidian の
      // 再保存など) 新しい blob に差し替える。
      // editedAt も落とす: 値がファイルと同じ = akashic の編集は既に上流にある
      // (push 後の DB 更新に失敗した記事を再取り込みで直す経路がここ)
      if (
        prev.dirty !== decision.dirty ||
        prev.githubSha !== blobSha ||
        prev.lastSyncedAt == null ||
        prev.editedAt != null
      ) {
        await prisma.article.update({
          where: { id: prev.id },
          data: { dirty: decision.dirty, githubSha: blobSha, lastSyncedAt: new Date(), editedAt: null },
        });
      }
      stats.skipped++;
      done++;
      continue;
    }

    // ここに来た akashic 編集済みの記事は「上流が変わった」ので、DB の未 push の編集は
    // ファイルで上書きされる (合意済みの解消手順)。黙って消さず、最後に一覧で知らせる。
    // 正規化だけの dirty は何も失わないので載せない
    if (prev?.editedAt != null) overwritten.push(file.path);

    const data = {
      ...cols,
      tags: cols.tags as object,
      frontmatterExtra: cols.frontmatterExtra as object,
      dirty: decision.dirty,
      githubSha: blobSha,
      lastSyncedAt: new Date(),
      // ファイルの内容に置き換えたので、akashic 側の編集はもう無い
      editedAt: null,
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
    `\n完了: 記事 ${done} 件 (うち変更なしでスキップ ${stats.skipped} 件、akashic の未 push 編集を残してスキップ ${stats.preserved} 件) / Asset 新規作成 ${stats.created} 件`,
  );
  console.log(`push 待ち (dirty) にした記事: ${stats.dirty} 件 → /articles/push から GitHub に書き出せます`);
  if (overwritten.length) {
    console.log(`\n--- akashic の未 push 編集があったが上流が変わっていたので上書きした (${overwritten.length} 件) ---`);
    for (const o of overwritten) console.log(`  ${o}`);
  }
  if (lossy.length) {
    console.log(`\n--- 値の差分があり dirty にしなかった (${lossy.length} 件) — push すると値が消えるので原因を確認する ---`);
    for (const l of lossy) console.log(`  ${l}`);
  }
}

main()
  .catch((e) => {
    console.error("ERR", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
