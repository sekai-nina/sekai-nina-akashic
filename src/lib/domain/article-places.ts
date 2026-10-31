import { PlaceCertainty, type Prisma } from "@prisma/client";
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
        certainty: true,
        certaintyNote: true,
        place: {
          select: { id: true, area: true, classification: true, entity: { select: { canonicalName: true } } },
        },
      },
    }),
  ).then((rows) =>
    rows.map(({ place, certainty, certaintyNote }) => ({
      id: place.id,
      name: place.entity.canonicalName,
      area: place.area,
      classification: place.classification,
      certainty,
      certaintyNote,
    })),
  );
}

export type ArticlePlaceItem = Awaited<ReturnType<typeof listArticlePlaces>>[number];

/**
 * 本文の描画 (`renderArticleBody` の `locations`) に渡す訪問。cardlink の `place_id:` と突き合わせて
 * ほぼ確定の印と理由を出す (#333)。公開サイトの frontmatter と同じく、ほぼ確定のものだけ確度を持つ
 */
export function toRenderLocations(visits: { placeId: string; certainty: PlaceCertainty; certaintyNote: string }[]) {
  return visits.map((v) =>
    v.certainty === PlaceCertainty.likely
      ? { place_id: v.placeId, certainty: "likely", certainty_note: v.certaintyNote.trim() }
      : { place_id: v.placeId },
  );
}

/** 聖地に紐づく記事 (`/places/[id]`)。Article は非保護だが行は ArticlePlace の RLS で絞られる */
export async function listArticlesForPlace(placeId: string, clearance: string) {
  return withClearance(clearance, (tx) =>
    tx.articlePlace.findMany({
      where: { placeId },
      orderBy: { article: { date: "desc" } },
      select: {
        certainty: true,
        certaintyNote: true,
        article: { select: { shortId: true, title: true, date: true, dateDisplay: true, draft: true } },
      },
    }),
  ).then((rows) => rows.map((r) => ({ ...r.article, certainty: r.certainty, certaintyNote: r.certaintyNote })));
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

/** 記事の 1 訪問 (編集画面から保存する形) */
export interface ArticlePlaceInput {
  placeId: string;
  certainty: PlaceCertainty;
  /** likely の理由。confirmed なら捨てる */
  certaintyNote: string;
}

const MAX_CERTAINTY_NOTE = 300;

/** 確定なら理由は持たない (書き出されないので、残すと「変わった」と誤判定する) */
function normalizeVisit(v: ArticlePlaceInput): ArticlePlaceInput {
  const likely = v.certainty === PlaceCertainty.likely;
  return {
    placeId: v.placeId,
    certainty: likely ? PlaceCertainty.likely : PlaceCertainty.confirmed,
    certaintyNote: likely ? v.certaintyNote.trim().slice(0, MAX_CERTAINTY_NOTE) : "",
  };
}

const visitKey = (v: ArticlePlaceInput) => `${v.placeId}\u0000${v.certainty}\u0000${v.certaintyNote}`;

/**
 * 記事の聖地を、操作者に見えている分だけ `visits` の並び (と各訪問の確度・理由、#333) に置き換える (記事の編集画面)。
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
  visits: ArticlePlaceInput[],
  actor: ArticleActor,
  clearance: string,
): Promise<SaveArticlePlacesResult> {
  const seen = new Set<string>();
  const nextVisits = visits.map(normalizeVisit).filter((v) => !seen.has(v.placeId) && seen.add(v.placeId));
  const next = nextVisits.map((v) => v.placeId);
  let audit: { before: string[]; after: string[]; certainty: Record<string, string> } | null = null;
  try {
    await withClearance(clearance, async (tx) => {
      const article = await tx.article.findUnique({ where: { shortId }, select: { id: true, updatedAt: true } });
      if (!article) throw new SaveAbort("not_found");
      if (article.updatedAt.getTime() !== expectedUpdatedAt.getTime()) throw new SaveAbort("conflict");

      const [current, places] = await Promise.all([
        tx.articlePlace.findMany({
          where: { articleId: article.id },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          select: { placeId: true, certainty: true, certaintyNote: true, place: { select: { classification: true } } },
        }),
        // 見えない (RLS) / 存在しない聖地は数が合わなくなる
        tx.place.findMany({ where: { id: { in: next } }, select: { id: true, classification: true } }),
      ]);
      if (places.length !== next.length) throw new SaveAbort("invalid_place");

      const before = current.map((r) => r.placeId);
      const beforeVisits: ArticlePlaceInput[] = current.map((r) => normalizeVisit(r));
      if (sameIds(beforeVisits.map(visitKey), nextVisits.map(visitKey))) return;
      audit = {
        before,
        after: next,
        certainty: Object.fromEntries(nextVisits.filter((v) => v.certainty === PlaceCertainty.likely).map((v) => [v.placeId, v.certaintyNote])),
      };

      // push の出力 (locations) に載る行どうしで比べる。確度・理由も出力に出る
      const classOf = new Map(places.map((p) => [p.id, p]));
      const publishedBefore = current.filter((r) => isPublishablePlace(r.place)).map((r) => visitKey(normalizeVisit(r)));
      const publishedAfter = nextVisits.filter((v) => isPublishablePlace(classOf.get(v.placeId)!)).map(visitKey);

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
        data: nextVisits.map((v, sortOrder) => ({ articleId: article.id, sortOrder, ...v })),
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
    metadata: { ...(audit as { before: string[]; after: string[]; certainty: Record<string, string> }), ...(actor.apiKeyId ? { apiKeyId: actor.apiKeyId } : {}) },
  }).catch((e: unknown) => console.error("article.places.update の監査ログに失敗:", e));
  return { ok: true, changed: true };
}

/**
 * 企画に付いた聖地を、その企画から作った記事の末尾に足す (企画で聖地を付けた / 昇格したとき)。
 * 記事を作るときにしか紐づけていなかったので、あとから企画に足した聖地が記事に出なかった。
 *
 * 呼び出し側 (企画の操作) のトランザクションの中で使う。すでに付いている記事は飛ばし、外しはしない。
 * 公開サイトに出る聖地なら dirty / editedAt を、出ないなら `updatedAt` だけを進める
 * (編集画面で古い一覧のまま保存して消さないように。`saveArticlePlaces` と同じ)。
 * 足した記事の shortId を返す
 */
export async function linkPlaceToDossierArticles(
  tx: Prisma.TransactionClient,
  dossierId: string,
  placeId: string,
): Promise<string[]> {
  const place = await tx.place.findUnique({ where: { id: placeId }, select: { classification: true } });
  if (!place) return [];
  // 企画の候補に付けた確度・理由を訪問に引き継ぐ (#333)
  const candidate = await tx.dossierPlaceCandidate.findFirst({
    where: { dossierId, placeId },
    orderBy: { sortOrder: "asc" },
    select: { certainty: true, certaintyNote: true },
  });
  const visit = normalizeVisit({
    placeId,
    certainty: candidate?.certainty ?? PlaceCertainty.confirmed,
    certaintyNote: candidate?.certaintyNote ?? "",
  });
  const articles = await tx.article.findMany({
    where: { dossierId, places: { none: { placeId } } },
    select: { id: true, shortId: true, places: { select: { sortOrder: true }, orderBy: { sortOrder: "desc" }, take: 1 } },
  });
  for (const a of articles) {
    await tx.articlePlace.create({
      data: { articleId: a.id, sortOrder: (a.places[0]?.sortOrder ?? -1) + 1, ...visit },
    });
    await tx.article.update({
      where: { id: a.id },
      data: isPublishablePlace(place) ? { dirty: true, editedAt: new Date() } : { updatedAt: new Date() },
    });
  }
  return articles.map((a) => a.shortId);
}
