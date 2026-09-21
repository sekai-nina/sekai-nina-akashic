/**
 * ドシエの中身を記事の組み立ての入力 (`ArticleAssetInput` など) に揃える (#170)。
 *
 * ミーグリ記事の組み立て (`meetgreet-article.ts`、#109) から、器に依らない部分を切り出したもの。
 * ドシエのアイテムを「アセット (抜粋つき)」「X のレポ」「TikTok」「サムネ」に振り分け、
 * **公開リポジトリに載せてよい機密レベル (`MAX_ARTICLE_CLEARANCE`) を超えるものを落とす**。
 *
 * `loadDossierForArticle` は呼び出し側の `withSession` の中 (`tx`) で動く (ドシエは所有者判定が要る)。
 * `shapeDossierMaterials` は純粋関数。
 */

import type { TransactionClient } from "@/lib/db";
import { getR2PublicUrl } from "@/lib/r2";
import { toJstDateOnly } from "@/lib/utils";
import { accessibleClassifications } from "@/lib/classification";
import { MAX_ARTICLE_CLEARANCE } from "@/lib/meetgreet/config";
import type { ArticleAssetInput } from "@/lib/article-workflow/render";

/** 本文に載せてよい機密レベル */
export const PUBLISHABLE = new Set<string>(accessibleClassifications(MAX_ARTICLE_CLEARANCE));

/** `loadDossierForArticle` が返すドシエ (組み立てに要る列だけ) */
export interface DossierForMaterials {
  id: string;
  title: string;
  classification: string;
  updatedAt: Date;
  itemCount: number;
  items: {
    kind: "asset_ref" | "external_link" | "external_image";
    caption: string;
    excerpt: string;
    externalUrl: string | null;
    externalImageKey: string | null;
    asset: {
      id: string;
      kind: ArticleAssetInput["kind"];
      title: string;
      canonicalDate: Date | null;
      classification: string;
      sourceRecords: { sourceKind: string; title: string; url: string | null; publishedAt: Date | null }[];
    } | null;
  }[];
}

/** ドシエとアイテムを読む。見えなければ null (権限か削除。呼び出し側が入力エラーにする) */
export async function loadDossierForArticle(
  tx: TransactionClient,
  dossierId: string
): Promise<DossierForMaterials | null> {
  const dossier = await tx.dossier.findUnique({
    where: { id: dossierId },
    select: {
      id: true,
      title: true,
      updatedAt: true,
      classification: true,
      _count: { select: { items: true } },
      items: {
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          kind: true,
          caption: true,
          excerpt: true,
          externalUrl: true,
          externalImageKey: true,
          asset: {
            select: {
              id: true,
              kind: true,
              title: true,
              canonicalDate: true,
              classification: true,
              sourceRecords: {
                select: { sourceKind: true, title: true, url: true, publishedAt: true },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                take: 1,
              },
            },
          },
        },
      },
    },
  });
  if (!dossier) return null;
  const { _count, ...rest } = dossier;
  return { ...rest, itemCount: _count.items };
}

export interface DossierMaterials {
  /** asset_ref のアイテム。同じアセットは抜粋をまとめて 1 件 */
  assets: ArticleAssetInput[];
  /** external_link の X の URL (ドシエの並び順) */
  reports: string[];
  /** external_link の TikTok の URL (**未解決**。短縮 URL のことがある) */
  tiktoks: string[];
  /** caption「サムネ」の external_image */
  dossierThumb: string | null;
  /** 機密レベルで落としたアセットの数 */
  droppedByClearance: number;
}

/** ドシエのアイテムを組み立ての入力に振り分ける (純粋関数) */
export function shapeDossierMaterials(dossier: DossierForMaterials): DossierMaterials {
  // アセットを 1 件にまとめる (同じアセットが抜粋ごとに複数 item になる)
  const assets = new Map<string, ArticleAssetInput>();
  const dropped = new Set<string>();
  const reports: string[] = [];
  const tiktoks: string[] = [];
  let dossierThumb: string | null = null;

  for (const item of dossier.items) {
    if (item.kind === "external_image") {
      if (item.caption === "サムネ" && item.externalImageKey) {
        dossierThumb = getR2PublicUrl(item.externalImageKey);
      }
      continue;
    }
    if (item.kind === "external_link") {
      // caption ではなくホストで振り分ける
      for (const raw of (item.externalUrl ?? "").split("\n")) {
        const u = raw.trim();
        if (!u) continue;
        if (u.includes("tiktok.com")) tiktoks.push(u);
        else if (/(?:x|twitter)\.com\//.test(u)) reports.push(u);
      }
      continue;
    }
    const a = item.asset;
    if (!a) continue;
    // 本文は公開リポジトリに載るので、上位機密のアセットは載せない
    if (!PUBLISHABLE.has(a.classification)) {
      dropped.add(a.id);
      continue;
    }
    const src = a.sourceRecords[0];
    const existing = assets.get(a.id);
    if (existing) {
      if (item.excerpt) existing.excerpts.push(item.excerpt);
      continue;
    }
    assets.set(a.id, {
      id: a.id,
      kind: a.kind,
      title: a.title,
      // UTC で切ると JST 0〜9 時のものが前日に落ちる
      canonicalDate: toJstDateOnly(a.canonicalDate),
      // 並べ替えは時刻まで見る (日付だけだと同じ日のトークが同着になる)
      sortAt: a.canonicalDate ? a.canonicalDate.toISOString() : null,
      source: src
        ? {
            kind: src.sourceKind,
            title: src.title,
            url: src.url,
            publishedAt: toJstDateOnly(src.publishedAt),
          }
        : null,
      excerpts: item.excerpt ? [item.excerpt] : [],
    });
  }

  return {
    assets: [...assets.values()],
    reports,
    tiktoks,
    dossierThumb,
    droppedByClearance: dropped.size,
  };
}

/**
 * TikTok の短縮 URL (vt.tiktok.com/...) を `/video/<id>` 入りの実 URL に解決する。
 * サイトの埋め込みは video ID を要るので、短縮のままだと埋め込みにならない
 * (generate.py の resolve_tiktok と同じ)。解決できなければ null。
 */
export async function resolveTiktokUrl(url: string): Promise<string | null> {
  if (url.includes("/video/")) return url.split("?")[0];
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const final = res.url;
    return final.includes("/video/") ? final.split("?")[0] : null;
  } catch {
    // **解決できなければ載せない。** 短縮 URL のままでは埋め込みにならず、
    // video ID が無いので次回の追記でも「既にある」と判定できず重複する
    return null;
  }
}

/** TikTok の URL をまとめて解決する。解決できなかったものは落とす (次回うまくいけば入る) */
export async function resolveTiktoks(urls: string[]): Promise<string[]> {
  const resolved = await Promise.all(urls.map((u) => resolveTiktokUrl(u)));
  return resolved.filter((u): u is string => u !== null);
}
