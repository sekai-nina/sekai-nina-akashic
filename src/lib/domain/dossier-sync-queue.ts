/**
 * 「記事に反映待ち」の企画 (記事が既にある企画に、まだ記事に載っていないクリップが入ったもの)。
 *
 * 記事の無い企画は `/dossiers` の「未記事化」に溜まるが、記事のある企画に足したクリップは
 * 一覧のどこにも出てこず探せなかった。ここで「記事に載っていないクリップ」を数えて、
 * 一覧の「反映待ち」タブと記事画面の「次の反映待ちへ」に使う。
 *
 * **判定は frontmatter の `dossier:` スナップショット (`loadNeedsSync`) を使わない。**
 * #41 のバックフィルで作った企画 (記事つき 299 本中 222 本) にはスナップショットが無く、
 * 今のクリップ運用で足す先はほとんどそちらなので。代わりにアセット単位で突き合わせる:
 *
 * - 未反映 = アセットを指すアイテムのうち、記事に載っておらず、
 *   「今後足さない」(`articleExclusions` の `asset:<id>`) にも入っていないもの
 * - 記事に載っている = どれかの紐づく記事の出典 (`ArticleSource`) になっている。
 *   **ブログ画像は本文の行でも見る。** ミーグリ・おでかけの「関連メディア」は画像を
 *   `【ブログ・画像】<アセットの題>^[n]` の行で載せ、出典はブログ本文の 1 行だけなので、
 *   画像のアセット自体は出典にならない (`render.ts` の `blogImageLine`)。出典だけで見ると
 *   載っている画像が全部「未反映」に見える
 * - 外部リンク・外部画像は数えない (出典の行にならず、記事に載ったかを突き合わせられない)
 * - アセットが見えない (上位機密) アイテムは数えない (一覧に出せず、片付けようがない)
 *
 * 記事画面で追記すれば載って消え、差分でチェックを外せば「今後足さない」に入って消える。
 * テンプレートが決まっている企画では、ここで数えたものと差分の候補が一致することを
 * 本番データで確かめてある (2026-10-25。数え方を変えたら差分と突き合わせ直すこと)
 */
import { withSession, type TransactionClient } from "@/lib/db";
import { jsonStringArray } from "@/lib/meetgreet/config";
import { exclusionKey } from "@/lib/meetgreet/append";
import type { ActingUser } from "./article-workflow";
import { NOT_CLIP_POOL } from "./dossiers";

export interface PendingClips {
  dossierId: string;
  title: string;
  /** 未反映のアイテム数 (同じアセットを抜粋ごとに入れたものは 1 件ずつ数える) */
  count: number;
  /** 未反映のアセット (重複なし、新しく入れた順) */
  assetIds: string[];
  /** 未反映のアイテムを最後に入れた日時 (一覧の並び順) */
  latestAt: Date;
}

interface DossierRow {
  id: string;
  title: string;
  articleExclusions: unknown;
  meetGreet: { articleExclusions: unknown } | null;
  live: { articleExclusions: unknown } | null;
  articles: { id: string }[];
  items: { assetId: string | null; createdAt: Date; asset: { kind: string; title: string } | null }[];
}

type Item = DossierRow["items"][number] & { assetId: string; asset: { kind: string; title: string } };

/** 出典にも除外にもなっていないアイテム (本文の突き合わせ前) */
function uncitedItems(row: DossierRow, citedByArticle: Map<string, Set<string>>): Item[] {
  const cited = new Set(row.articles.flatMap((a) => [...(citedByArticle.get(a.id) ?? [])]));
  const excluded = new Set(storedExclusions(row));
  return row.items
    .filter((i): i is Item => !!i.assetId && !!i.asset)
    .filter((i) => !cited.has(i.assetId) && !excluded.has(exclusionKey("source", i.assetId)));
}

/** ブログ画像が本文の「関連メディア」の行に載っているか (`blogImageLine` の形) */
function imageInBody(item: Item, bodies: string[]): boolean {
  if (item.asset.kind !== "image" || !item.asset.title) return false;
  const needle = `】${item.asset.title}^[`;
  return bodies.some((b) => b.includes(needle));
}

/**
 * 除外キーの置き場。器 (MeetGreet / Live) のある企画は器が持ち、無ければ企画が持つ
 * (`article-generate.ts` の `resolveTarget` と同じ)
 */
function storedExclusions(row: Pick<DossierRow, "articleExclusions" | "meetGreet" | "live">): string[] {
  return jsonStringArray((row.meetGreet ?? row.live ?? row).articleExclusions);
}

/**
 * 純粋関数。`citedByArticle` は記事 ID → 出典になっているアセット ID、
 * `bodyByArticle` は記事 ID → 本文 (ブログ画像の突き合わせ用)
 */
export function computePending(
  row: DossierRow,
  citedByArticle: Map<string, Set<string>>,
  bodyByArticle: Map<string, string>
): PendingClips | null {
  if (row.articles.length === 0) return null;
  const bodies = row.articles.map((a) => bodyByArticle.get(a.id) ?? "");
  const pending = uncitedItems(row, citedByArticle)
    .filter((i) => !imageInBody(i, bodies))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (pending.length === 0) return null;
  return {
    dossierId: row.id,
    title: row.title,
    count: pending.length,
    assetIds: [...new Set(pending.map((i) => i.assetId))],
    latestAt: pending[0].createdAt,
  };
}

const DOSSIER_SELECT = {
  id: true,
  title: true,
  articleExclusions: true,
  meetGreet: { select: { articleExclusions: true } },
  live: { select: { articleExclusions: true } },
  articles: { select: { id: true } },
  items: {
    where: { kind: "asset_ref" },
    select: { assetId: true, createdAt: true, asset: { select: { kind: true, title: true } } },
  },
} as const;

async function loadPending(tx: TransactionClient, dossierIds?: string[]): Promise<PendingClips[]> {
  const rows = await tx.dossier.findMany({
    where: { ...NOT_CLIP_POOL, articles: { some: {} }, ...(dossierIds ? { id: { in: dossierIds } } : {}) },
    select: DOSSIER_SELECT,
  });
  const articleIds = rows.flatMap((r) => r.articles.map((a) => a.id));
  // ArticleSource は保護テーブル。withSession の中で引く (素の prisma だと無言で 0 行 = 全部未反映に見える)
  const sources = articleIds.length
    ? await tx.articleSource.findMany({
        where: { articleId: { in: articleIds }, assetId: { not: null } },
        select: { articleId: true, assetId: true },
      })
    : [];
  const cited = new Map<string, Set<string>>();
  for (const s of sources) {
    const set = cited.get(s.articleId) ?? new Set<string>();
    set.add(s.assetId!);
    cited.set(s.articleId, set);
  }
  // 本文は、出典になっていない画像を持つ企画の記事だけ引く (全記事の本文は重い)。
  // Article は非保護テーブルだが、同じ接続で読めば済むので tx のまま
  const needBodies = rows
    .filter((r) => uncitedItems(r, cited).some((i) => i.asset.kind === "image"))
    .flatMap((r) => r.articles.map((a) => a.id));
  const bodies = needBodies.length
    ? new Map(
        (await tx.article.findMany({ where: { id: { in: needBodies } }, select: { id: true, body: true } })).map(
          (a) => [a.id, a.body]
        )
      )
    : new Map<string, string>();
  return rows
    .map((r) => computePending(r, cited, bodies))
    .filter((p): p is PendingClips => !!p)
    .sort((a, b) => b.latestAt.getTime() - a.latestAt.getTime());
}

/** 反映待ちの企画を、未反映のクリップを最後に入れた日が新しい順で返す */
export async function listPendingClips(user: ActingUser): Promise<PendingClips[]> {
  return withSession(user, (tx) => loadPending(tx));
}

export interface UnreflectedClip {
  assetId: string;
  title: string;
  kind: string;
  canonicalDate: Date | null;
  /** 抜粋つきで入れたものは先頭の抜粋 */
  excerpt: string;
}

/** 1 つの企画の未反映クリップの中身 (記事画面の一覧) */
export async function getUnreflectedClips(user: ActingUser, dossierId: string): Promise<UnreflectedClip[]> {
  return withSession(user, async (tx) => {
    const [pending] = await loadPending(tx, [dossierId]);
    if (!pending) return [];
    const items = await tx.dossierItem.findMany({
      where: { dossierId, assetId: { in: pending.assetIds } },
      orderBy: { createdAt: "desc" },
      select: {
        assetId: true,
        excerpt: true,
        asset: { select: { title: true, kind: true, canonicalDate: true } },
      },
    });
    const byAsset = new Map<string, UnreflectedClip>();
    for (const it of items) {
      if (!it.assetId || !it.asset || byAsset.has(it.assetId)) continue;
      byAsset.set(it.assetId, {
        assetId: it.assetId,
        title: it.asset.title,
        kind: it.asset.kind,
        canonicalDate: it.asset.canonicalDate,
        excerpt: it.excerpt,
      });
    }
    return pending.assetIds.flatMap((id) => byAsset.get(id) ?? []);
  });
}
