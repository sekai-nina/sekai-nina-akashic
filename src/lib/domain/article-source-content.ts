import type { AssetKind, TextType } from "@prisma/client";
import { withClearance } from "@/lib/db";

/** 記事の編集画面で、出典の中身を横に出すためのもの */
export interface ArticleSourceContent {
  sourceNo: number | null;
  label: string;
  url: string | null;
  /** 出典として切り出した抜粋 (無ければ空) */
  excerpt: string;
  asset: {
    id: string;
    title: string;
    kind: AssetKind;
    canonicalDate: string | null;
    /** 画像のアセットなら表示用の URL */
    imageUrl: string | null;
    /** 本文 (ブログは `{{IMG:<assetId>}}` で画像の位置を持つ) */
    texts: { textType: TextType; content: string }[];
    /** 本文に埋め込まれた画像 */
    embeddedImages: Record<string, { thumbnailUrl: string | null; title: string }>;
  } | null;
}

const IMG_PLACEHOLDER = /\{\{IMG:([a-zA-Z0-9_-]+)\}\}/g;

/** 画像の表示用 URL (アセット詳細と同じ順で選ぶ) */
function imageUrlOf(a: {
  kind: AssetKind;
  thumbnailUrl: string | null;
  storageProvider: string;
  storageKey: string | null;
  storageUrl: string | null;
}): string | null {
  if (a.kind !== "image") return null;
  if (a.thumbnailUrl) return a.thumbnailUrl;
  if (a.storageProvider === "gdrive" && a.storageKey) return `/api/drive-image/${a.storageKey}`;
  return a.storageUrl;
}

/**
 * 記事の出典 1 件の中身。見えない (クリアランスが足りない) アセットは `asset: null` で返る
 */
export async function getArticleSourceContent(
  clearance: string,
  shortId: string,
  sourceId: string
): Promise<ArticleSourceContent | null> {
  return withClearance(clearance, async (tx) => {
    const source = await tx.articleSource.findFirst({
      where: { id: sourceId, article: { shortId } },
      select: {
        sourceNo: true,
        label: true,
        url: true,
        excerpt: true,
        asset: {
          select: {
            id: true,
            title: true,
            kind: true,
            canonicalDate: true,
            thumbnailUrl: true,
            storageProvider: true,
            storageKey: true,
            storageUrl: true,
            texts: {
              where: { textType: { notIn: ["title", "annotation"] } },
              orderBy: { createdAt: "asc" },
              select: { textType: true, content: true },
            },
          },
        },
      },
    });
    if (!source) return null;
    const a = source.asset;
    const embeddedIds = new Set(a?.texts.flatMap((t) => [...t.content.matchAll(IMG_PLACEHOLDER)].map((m) => m[1])) ?? []);
    const embedded =
      embeddedIds.size > 0
        ? await tx.asset.findMany({ where: { id: { in: [...embeddedIds] } }, select: { id: true, thumbnailUrl: true, title: true } })
        : [];
    return {
      sourceNo: source.sourceNo,
      label: source.label,
      url: source.url,
      excerpt: source.excerpt,
      asset: a
        ? {
            id: a.id,
            title: a.title,
            kind: a.kind,
            canonicalDate: a.canonicalDate?.toISOString() ?? null,
            imageUrl: imageUrlOf(a),
            texts: a.texts,
            embeddedImages: Object.fromEntries(embedded.map((e) => [e.id, { thumbnailUrl: e.thumbnailUrl, title: e.title }])),
          }
        : null,
    };
  });
}
