import { withClearance } from "@/lib/db";
import { isPublishablePlace } from "@/lib/articles/frontmatter";
import { logAudit } from "@/lib/domain/audit";
import type { ArticleActor } from "@/lib/domain/articles";

/**
 * 記事と聖地の紐づけ (ArticlePlace, #283)。
 *
 * ArticlePlace は保護テーブル (紐づく Place の classification に従う) なので、すべて
 * `withClearance` の中で読み書きする。操作者より上のクリアランスの聖地の行は RLS で
 * 見えず、消えもしない (置き換えは見えている行だけ)。
 *
 * push の出力 (`locations`) に載るのは Place が public / internal の行だけ
 * (`isPublishablePlace`)。その並びが変わったときだけ `dirty` / `editedAt` を立てる。
 * confidential 以上の付け外しは公開リポジトリに何も出ないので立てない。
 */

/** 記事に紐づく聖地 (操作者に見える分、記事内の並び順) */
export async function listArticlePlaces(articleId: string, clearance: string) {
  return withClearance(clearance, (tx) =>
    tx.articlePlace.findMany({
      where: { articleId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        place: {
          select: { id: true, area: true, classification: true, entity: { select: { canonicalName: true } } },
        },
      },
    }),
  ).then((rows) =>
    rows.map(({ place }) => ({
      id: place.id,
      name: place.entity.canonicalName,
      area: place.area,
      classification: place.classification,
    })),
  );
}

export type ArticlePlaceItem = Awaited<ReturnType<typeof listArticlePlaces>>[number];

/** 聖地に紐づく記事 (`/places/[id]`)。Article は非保護だが行は ArticlePlace の RLS で絞られる */
export async function listArticlesForPlace(placeId: string, clearance: string) {
  return withClearance(clearance, (tx) =>
    tx.articlePlace.findMany({
      where: { placeId },
      orderBy: { article: { date: "desc" } },
      select: {
        article: { select: { shortId: true, title: true, date: true, dateDisplay: true, draft: true } },
      },
    }),
  ).then((rows) => rows.map((r) => r.article));
}

export type SaveArticlePlacesResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: "not_found" | "invalid_place" | "conflict" };

class SaveAbort extends Error {
  constructor(readonly reason: "not_found" | "invalid_place" | "conflict") {
    super(reason);
  }
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * 記事の聖地を、操作者に見えている分だけ `placeIds` の並びに置き換える (記事の編集画面)。
 *
 * 楽観ロックは記事の編集と同じ `updatedAt`。編集画面は本文の保存 (`updateArticle`) の後に
 * これを呼ぶので、そこで返った `updatedAt` を渡す。並びが変わったら、push の出力に関係なく
 * **書く前に** `updatedAt` を進める (非公開の聖地だけの付け外しでも、同じ記事を開いていた
 * 別の人の古い一覧で上書きして消さないため)。記事の行のロックで同時の保存も直列になり、
 * 後から来た方は `conflict` になる。push の出力が変わるときだけ dirty / editedAt も立てる。
 */
export async function saveArticlePlaces(
  shortId: string,
  expectedUpdatedAt: Date,
  placeIds: string[],
  actor: ArticleActor,
  clearance: string,
): Promise<SaveArticlePlacesResult> {
  const next = [...new Set(placeIds)];
  let audit: { before: string[]; after: string[] } | null = null;
  try {
    await withClearance(clearance, async (tx) => {
      const article = await tx.article.findUnique({ where: { shortId }, select: { id: true, updatedAt: true } });
      if (!article) throw new SaveAbort("not_found");
      if (article.updatedAt.getTime() !== expectedUpdatedAt.getTime()) throw new SaveAbort("conflict");

      const [current, places] = await Promise.all([
        tx.articlePlace.findMany({
          where: { articleId: article.id },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          select: { placeId: true, place: { select: { classification: true } } },
        }),
        // 見えない (RLS) / 存在しない聖地は数が合わなくなる
        tx.place.findMany({ where: { id: { in: next } }, select: { id: true, classification: true } }),
      ]);
      if (places.length !== next.length) throw new SaveAbort("invalid_place");

      const before = current.map((r) => r.placeId);
      if (sameIds(before, next)) return;
      audit = { before, after: next };

      const classOf = new Map(places.map((p) => [p.id, p]));
      const publishedBefore = current.filter((r) => isPublishablePlace(r.place)).map((r) => r.placeId);
      const publishedAfter = next.filter((id) => isPublishablePlace(classOf.get(id)!));

      const { count } = await tx.article.updateMany({
        where: { id: article.id, updatedAt: expectedUpdatedAt },
        data: sameIds(publishedBefore, publishedAfter)
          ? { updatedAt: new Date() }
          : { dirty: true, editedAt: new Date() },
      });
      if (count === 0) throw new SaveAbort("conflict");

      // 見えている行だけ置き換える (操作者より上のクリアランスの行は RLS で見えず、消えもしない)
      await tx.articlePlace.deleteMany({ where: { articleId: article.id, placeId: { in: before } } });
      await tx.articlePlace.createMany({
        data: next.map((placeId, sortOrder) => ({ articleId: article.id, placeId, sortOrder })),
      });
    });
  } catch (e) {
    if (e instanceof SaveAbort) return { ok: false, reason: e.reason };
    throw e;
  }

  if (!audit) return { ok: true, changed: false };
  await logAudit({
    actorId: actor.id,
    action: "article.places.update",
    targetType: "Article",
    targetId: shortId,
    metadata: { ...(audit as { before: string[]; after: string[] }), ...(actor.apiKeyId ? { apiKeyId: actor.apiKeyId } : {}) },
  }).catch((e: unknown) => console.error("article.places.update の監査ログに失敗:", e));
  return { ok: true, changed: true };
}
