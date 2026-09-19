/**
 * ミーグリ記事の生成 (#109)。
 *
 * ドシエと X レポから記事の本文・出典を組み立てる。組み立て自体は純粋関数
 * (`src/lib/meetgreet/article.ts`) で、ここは DB からの入力の用意に徹する。
 */

import { withSession } from "@/lib/db";
import { getR2PublicUrl } from "@/lib/r2";
import { toJstDateOnly, todayJst } from "@/lib/utils";
import { accessibleClassifications } from "@/lib/classification";
import { MAX_ARTICLE_CLEARANCE } from "@/lib/meetgreet/config";
import {
  normalizeTweetUrl,
  renderMeetGreetArticle,
  type ArticleAssetInput,
  type RenderedArticle,
} from "@/lib/meetgreet/article";
import { MeetGreetInputError, type ActingUser } from "./meetgreets";

/** 本文に載せてよい機密レベル */
const PUBLISHABLE = new Set<string>(accessibleClassifications(MAX_ARTICLE_CLEARANCE));

/**
 * TikTok の短縮 URL (vt.tiktok.com/...) を `/video/<id>` 入りの実 URL に解決する。
 * サイトの埋め込みは video ID を要るので、短縮のままだと埋め込みにならない
 * (generate.py の resolve_tiktok と同じ)。解決できなければ元の URL を返す。
 */
export async function resolveTiktokUrl(url: string): Promise<string> {
  if (url.includes("/video/")) return url.split("?")[0];
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10_000),
    });
    const final = res.url;
    return final.includes("/video/") ? final.split("?")[0] : url;
  } catch {
    return url; // 解決できなくても生成は止めない
  }
}

export interface BuildArticleOptions {
  /** X レポ収集の keep を取り込むか (既存記事との突き合わせ検証では false にする) */
  includeKeeps?: boolean;
  /** published_at / synced_at に入れる日。既定は JST の今日 */
  today?: string;
}

/**
 * ドシエと収集から記事を組み立てる。DB には書かない。
 *
 * レポはドシエの `external_link` を先に、X レポ収集の keep を後ろに足す
 * (既存記事の並びを壊さず、判定済みのぶんだけ増える形にする)。
 */
export async function buildMeetGreetArticle(
  user: ActingUser,
  meetGreet: {
    id: string;
    date: string;
    format: "online" | "real";
    venue: string | null;
    label: string;
    single: string;
    dossierId: string;
    repoCollectionId: string | null;
    sketchKey: string | null;
    classification: string;
  },
  options: BuildArticleOptions = {}
): Promise<RenderedArticle & { droppedByClearance: number }> {
  const includeKeeps = options.includeKeeps ?? true;

  // **記事の本文は公開リポジトリに載る。** アセット単位の絞り込み (PUBLISHABLE) だけでは
  // ドシエのサムネ・外部リンク・スケッチが素通りするので、器の機密も入口で見る
  if (!PUBLISHABLE.has(meetGreet.classification)) {
    throw new MeetGreetInputError(
      `このミーグリは ${meetGreet.classification} なので記事にできません (公開リポジトリに載るため ${MAX_ARTICLE_CLEARANCE} 以下のみ)`
    );
  }

  const data = await withSession(user, async (tx) => {
    const dossier = await tx.dossier.findUnique({
      where: { id: meetGreet.dossierId },
      select: {
        id: true,
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
    // ドシエが見えないのは権限の話なので、呼び出し側が 400 にできる形で投げる
    if (!dossier) throw new MeetGreetInputError("ドシエが見つかりません (権限がないか削除されています)");

    const collection = meetGreet.repoCollectionId
      ? await tx.repoCollection.findUnique({
          where: { id: meetGreet.repoCollectionId },
          select: { classification: true },
        })
      : null;

    const keeps =
      includeKeeps && meetGreet.repoCollectionId
        ? await tx.repoTweet.findMany({
            where: { collectionId: meetGreet.repoCollectionId, status: "keep" },
            orderBy: [{ tweetedAt: "asc" }, { id: "asc" }],
            select: { url: true },
          })
        : [];
    if (!PUBLISHABLE.has(dossier.classification)) {
      throw new MeetGreetInputError(
        `ドシエが ${dossier.classification} なので記事にできません (サムネや外部リンクが公開リポジトリに載るため)`
      );
    }
    return { dossier, keeps, collection };
  });

  // アセットを 1 件にまとめる (同じアセットが抜粋ごとに複数 item になる)
  const assets = new Map<string, ArticleAssetInput>();
  const dropped = new Set<string>();
  const reports: string[] = [];
  const tiktoks: string[] = [];
  let dossierThumb: string | null = null;

  for (const item of data.dossier.items) {
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

  // TikTok は埋め込みに video ID が要るので、短縮 URL をここで解決しておく
  const resolvedTiktoks = await Promise.all(tiktoks.map((u) => resolveTiktokUrl(u)));

  // keep を後ろに足す (ドシエに既にある URL は重複させない)。
  // RepoTweet は自前の機密を持たず収集の機密に従うので、ここで見る
  const keepsPublishable = !data.collection || PUBLISHABLE.has(data.collection.classification);
  const seen = new Set(reports.map(normalizeTweetUrl));
  for (const t of keepsPublishable ? data.keeps : []) {
    const n = normalizeTweetUrl(t.url);
    if (seen.has(n)) continue;
    seen.add(n);
    reports.push(t.url);
  }

  return {
    ...renderMeetGreetArticle({
    date: meetGreet.date,
    format: meetGreet.format,
    // **label は使わない。** label は「通常」「初限」も入る内部用の呼び分けで、
    // タイトルに出すと `リアルミーグリ（通常）` になり、path も既存ファイルとずれて
    // 別記事が新規作成されてしまう。会場名は venue に入れる
    venue: meetGreet.venue?.trim() || null,
    single: meetGreet.single,
    assets: [...assets.values()],
    reports,
    tiktoks: resolvedTiktoks,
    thumbnailUrl: meetGreet.sketchKey ? getR2PublicUrl(meetGreet.sketchKey) : dossierThumb,
    dossier: {
      id: data.dossier.id,
      updatedAt: data.dossier.updatedAt.toISOString(),
      itemCount: data.dossier._count.items,
    },
    today: options.today ?? todayJst(),
    }),
    droppedByClearance: dropped.size,
  };
}
