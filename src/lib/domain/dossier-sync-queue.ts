/**
 * 「記事に反映待ち」の企画 (記事が既にある企画に、まだ記事に載っていないクリップが入ったもの)。
 *
 * 記事の無い企画は `/dossiers` の「未記事化」に溜まるが、記事のある企画に足したクリップは
 * 一覧のどこにも出てこず探せなかった。ここで「記事に載っていないクリップ」を数えて、
 * 一覧の「反映待ち」タブと記事画面の「次の反映待ちへ」に使う。
 *
 * **判定は frontmatter の `dossier:` スナップショット (`loadNeedsSync`) を使わない。**
 * #41 のバックフィルで作った企画 (記事つき 299 本中 222 本) にはスナップショットが無く、
 * 今のクリップ運用で足す先はほとんどそちらなので。
 *
 * 代わりにアイテムごとに「追記の差分 (`planAppend`) がそれを足すものに出すか」を写して判定する。
 * 差分は 1 本ごとに素材の解決 (TikTok 等) を伴うので、一覧のために全企画で回せない。
 * **ここと差分の規則がずれると、差分に出ないのに反映待ちに居座る企画ができる** (片付ける手段が無い)。
 * テンプレートや `planAppend` の「既にある」「足さない」の規則を変えたら合わせること。
 *
 * - 抜粋 (本文 text の抜粋) は、引用を本文に足すテンプレート (ミーグリ・ライブ・言葉 (ブログ)) では
 *   **先頭行が本文にあるか**で見る。同じブログの 2 つ目の抜粋は、ブログが出典済みでも差分に出る。
 *   除外キーは `quote:<先頭行の指紋>`。運営ブログ (ひなたぼっこ日記) の抜粋は引用にならない
 * - ブログ画像は「関連メディア」の `【…画像】<アセットの題>^[n]` の行があるかで見る。
 *   画像自体は出典にならない (出典はブログ本文の 1 行) ので、出典だけで見ると載っている画像が全部未反映に見える
 * - それ以外 (トーク・本文を AI / 人が書くテンプレートの素材) は出典 (`ArticleSource`) になっているかで見る。
 *   出典は ID のほか URL でも突き合わせる (`planAppend` と同じ。URL だけの出典や、先頭画像が出典のブログがある)
 * - テンプレートが使わない素材は数えない: 言葉 (ブログ) は抜粋だけ、器のテンプレートの抜粋の無い本文は単独では載らない
 * - 公開リポジトリに載せられない機密のアセット (`PUBLISHABLE` の外) は数えない (組み立てで落ちる)
 * - アセットが見えない (上位機密) アイテム、外部リンク・外部画像は数えない
 * - 紐づく記事が複数あれば、どれかに載っていれば反映済み
 *
 * 2026-10-25 に本番データで、テンプレートが決まっている企画は差分の候補と一致することを確かめた。
 */
import type { Prisma } from "@prisma/client";
import { withSession, type TransactionClient } from "@/lib/db";
import { jsonStringArray } from "@/lib/meetgreet/config";
import { exclusionKey, quoteHead } from "@/lib/meetgreet/append";
import { isStaffBlog, isTalk, normalizeSourceUrl } from "@/lib/article-workflow/render";
import type { ActingUser } from "./article-workflow";
import { NOT_CLIP_POOL } from "./dossiers";
import { PUBLISHABLE } from "./dossier-materials";

export interface PendingClip {
  itemId: string;
  assetId: string;
  title: string;
  kind: string;
  canonicalDate: Date | null;
  excerpt: string;
  createdAt: Date;
}

export interface PendingDossier {
  dossierId: string;
  title: string;
  /** 未反映のアイテム (新しく入れた順)。同じアセットを抜粋ごとに入れたものは別々に並ぶ */
  clips: PendingClip[];
  /** 未反映のアイテムを最後に入れた日時 (一覧の並び順) */
  latestAt: Date;
}

export interface ItemRow {
  id: string;
  assetId: string | null;
  excerpt: string;
  createdAt: Date;
  asset: {
    kind: string;
    title: string;
    canonicalDate: Date | null;
    classification: string;
    sourceRecords: { sourceKind: string; title: string; url: string | null }[];
  } | null;
}

export interface DossierRow {
  id: string;
  title: string;
  articleTemplate: string | null;
  articleExclusions: unknown;
  meetGreet: { articleExclusions: unknown } | null;
  live: { articleExclusions: unknown } | null;
  articles: { id: string }[];
  items: ItemRow[];
}

/** 記事側の状態 (紐づく記事をまとめたもの) */
export interface ArticleState {
  citedAssets: Set<string>;
  /** `normalizeSourceUrl` 済み */
  citedUrls: Set<string>;
  bodies: string[];
}

/** 引用を本文に足すテンプレート。器のドシエは `articleTemplate` に器の種類が入っている */
const QUOTE_TEMPLATES = new Set(["meetgreet", "live", "quote_blog"]);
/** トーク・ブログ画像を「関連メディア」の行で足すテンプレート (行の有無で判定し、出典では見ない) */
const MEDIA_TEMPLATES = new Set(["meetgreet", "live", "outing"]);

/**
 * 除外キーの置き場。器 (MeetGreet / Live) のある企画は器が持ち、無ければ企画が持つ
 * (`article-generate.ts` の `resolveTarget` と同じ)
 */
function storedExclusions(row: Pick<DossierRow, "articleExclusions" | "meetGreet" | "live">): string[] {
  return jsonStringArray((row.meetGreet ?? row.live ?? row).articleExclusions);
}

/** 本文の行の中身 (脚注番号を外したもの)。`planAppend` の `lineCore` と同じ */
function lineCores(bodies: string[]): string[] {
  return bodies.flatMap((b) => b.split("\n").map((l) => l.replace(/\^\[\d+\]\s*$/, "").trim()));
}

type Verdict = "pending" | "done" | "ignored";

/** 1 アイテムの判定。純粋関数 */
export function judgeItem(
  item: ItemRow,
  template: string | null,
  excluded: Set<string>,
  article: ArticleState,
  cores: string[]
): Verdict {
  const asset = item.asset;
  if (!item.assetId || !asset) return "ignored";
  if (!PUBLISHABLE.has(asset.classification)) return "ignored";
  const src = asset.sourceRecords[0] ?? null;
  const talk = isTalk({
    id: item.assetId,
    kind: asset.kind as never,
    title: asset.title,
    canonicalDate: null,
    sortAt: null,
    source: src ? { kind: src.sourceKind, title: src.title, url: src.url, publishedAt: null } : null,
    excerpts: [],
  });
  const quotes = !!template && QUOTE_TEMPLATES.has(template);
  const assetExcluded = excluded.has(exclusionKey("source", item.assetId));
  const citedById = article.citedAssets.has(item.assetId);
  const cited = citedById || (!!src?.url && article.citedUrls.has(normalizeSourceUrl(src.url)));

  if (asset.kind === "text" && !talk) {
    if (quotes) {
      // 引用になるのは抜粋つきで、運営ブログでないものだけ。それ以外の本文は単独では載らない
      const head = quoteHead(item.excerpt);
      if (!head || isStaffBlog(src?.url)) return "ignored";
      if (excluded.has(exclusionKey("quote", item.excerpt))) return "ignored";
      return article.bodies.some((b) => b.includes(head)) ? "done" : "pending";
    }
    if (assetExcluded) return "ignored";
    return cited ? "done" : "pending";
  }
  // 言葉 (ブログ) は引用の元のブログだけを組み立てる。画像・トークは使わない
  if (template === "quote_blog") return "ignored";
  if (assetExcluded) return "ignored";
  // トークは行の脚注が自分を指すので、ID で出典になっていれば載っている
  if (talk) return citedById ? "done" : "pending";
  // ブログ画像は「関連メディア」の行 (`blogImageLine`) で載る。行の形は `planAppend` の `hasLine` と同じく
  // 脚注を外した行全体で見る (`】` で題の前を区切り、`(1/11)` の付かない題の前方一致を避ける)
  const inBody = !!asset.title && cores.some((c) => c.endsWith(`】${asset.title}`));
  if (inBody) return "done";
  // 行で足すテンプレートでは、同じブログの本文が出典済みでも新しい画像は差分に出る。それ以外
  // (スナップ・言葉 (場面)・未設定) は画像も出典として提示され、URL で既存の出典に当たれば出ない
  if (template && MEDIA_TEMPLATES.has(template)) return "pending";
  return cited ? "done" : "pending";
}

/** 純粋関数。記事の無い企画・未反映の無い企画は null */
export function computePending(row: DossierRow, article: ArticleState): PendingDossier | null {
  if (row.articles.length === 0) return null;
  const excluded = new Set(storedExclusions(row));
  const cores = lineCores(article.bodies);
  const clips = row.items
    .filter((i) => judgeItem(i, row.articleTemplate, excluded, article, cores) === "pending")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((i) => ({
      itemId: i.id,
      assetId: i.assetId!,
      title: i.asset!.title,
      kind: i.asset!.kind,
      canonicalDate: i.asset!.canonicalDate,
      excerpt: i.excerpt,
      createdAt: i.createdAt,
    }));
  if (clips.length === 0) return null;
  return { dossierId: row.id, title: row.title, clips, latestAt: clips[0].createdAt };
}

const DOSSIER_SELECT = {
  id: true,
  title: true,
  articleTemplate: true,
  articleExclusions: true,
  meetGreet: { select: { articleExclusions: true } },
  live: { select: { articleExclusions: true } },
  articles: { select: { id: true } },
  items: {
    where: { kind: "asset_ref" },
    select: {
      id: true,
      assetId: true,
      excerpt: true,
      createdAt: true,
      asset: {
        select: {
          kind: true,
          title: true,
          canonicalDate: true,
          classification: true,
          // 組み立てと同じ 1 件 (`dossier-materials.ts` の ASSET_SELECT)
          sourceRecords: {
            select: { sourceKind: true, title: true, url: true },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: 1,
          },
        },
      },
    },
  },
} satisfies Prisma.DossierSelect;

async function loadPending(tx: TransactionClient): Promise<PendingDossier[]> {
  const rows = await tx.dossier.findMany({
    where: { ...NOT_CLIP_POOL, articles: { some: {} } },
    select: DOSSIER_SELECT,
  });
  const articleIds = rows.flatMap((r) => r.articles.map((a) => a.id));
  if (articleIds.length === 0) return [];
  // ArticleSource は保護テーブル。withSession の中で引く (素の prisma だと無言で 0 行 = 全部未反映に見える)
  const sources = await tx.articleSource.findMany({
    where: { articleId: { in: articleIds } },
    select: { articleId: true, assetId: true, url: true },
  });
  const sourcesByArticle = new Map<string, typeof sources>();
  for (const s of sources) sourcesByArticle.set(s.articleId, [...(sourcesByArticle.get(s.articleId) ?? []), s]);
  // 本文は全記事ぶん引く (約 300 本)。抜粋と画像の判定に要り、絞り込む条件を先に計算するほうが複雑になる
  const articles = await tx.article.findMany({ where: { id: { in: articleIds } }, select: { id: true, body: true } });
  const bodyById = new Map(articles.map((a) => [a.id, a.body]));
  return rows
    .map((r) => {
      const mine = r.articles.flatMap((a) => sourcesByArticle.get(a.id) ?? []);
      return computePending(r, {
        citedAssets: new Set(mine.flatMap((s) => (s.assetId ? [s.assetId] : []))),
        citedUrls: new Set(mine.flatMap((s) => (s.url ? [normalizeSourceUrl(s.url)] : []))),
        bodies: r.articles.map((a) => bodyById.get(a.id) ?? ""),
      });
    })
    .filter((p): p is PendingDossier => !!p)
    .sort((a, b) => b.latestAt.getTime() - a.latestAt.getTime());
}

/**
 * 反映待ちの企画を、未反映のクリップを最後に入れた日が新しい順で返す。
 * 記事画面はここから自分の企画を取り出す (企画 1 本だけを判定し直さない)
 */
export async function listPendingDossiers(user: ActingUser): Promise<PendingDossier[]> {
  return withSession(user, (tx) => loadPending(tx));
}
