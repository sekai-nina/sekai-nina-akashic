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

import type { ClearanceLevel, Prisma, TextType } from "@prisma/client";
import type { TransactionClient } from "@/lib/db";
import { getR2PublicUrl } from "@/lib/r2";
import { toJstDateOnly } from "@/lib/utils";
import { accessibleClassifications } from "@/lib/classification";
import { MAX_ARTICLE_CLEARANCE, MAX_EXTERNAL_AI_CLEARANCE } from "@/lib/meetgreet/config";
import type { ArticleAssetInput } from "@/lib/article-workflow/render";
import type { DossierPlace } from "@/lib/article-workflow/templates/types";

/** 本文に載せてよい機密レベル */
export const PUBLISHABLE = new Set<string>(accessibleClassifications(MAX_ARTICLE_CLEARANCE));
/** 外部の AI に渡してよい機密レベル (本文全文を送るので、本文に載る上限とは別に見る) */
export const EXTERNAL_AI_OK = new Set<string>(accessibleClassifications(MAX_EXTERNAL_AI_CLEARANCE));

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
      /** `withTexts` のときだけ (AI に渡す本文と人物) */
      texts?: { textType: TextType; content: string }[];
      entities?: { entity: { canonicalName: string } }[];
    } | null;
  }[];
  /** 場所候補 (ドシエの並び順)。おでかけ記事の `locations` になる */
  placeCandidates: {
    name: string;
    placeId: string | null;
    latitude: number | null;
    longitude: number | null;
    address: string | null;
    googleMapsUrl: string | null;
    note: string;
    /** 昇格先の聖地。RLS で見えなければ null (= 上位機密。記事にも AI にも出さない) */
    place: { classification: string; entity: { canonicalName: string } } | null;
  }[];
  /**
   * `withTexts` のときだけ。ドシエに**画像しか入っていないブログ**の本文アセット (同じ URL の text)。
   * 人はブログを読んで書くので、画像だけ選んであっても本文を AI に渡す。ドシエのアイテムでは
   * ないので抜粋は無い。RLS と機密の上限は普通のアイテムと同じに効く
   */
  extraTextAssets?: NonNullable<DossierForMaterials["items"][number]["asset"]>[];
}

const ASSET_SELECT = {
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
} satisfies Prisma.AssetSelect;

/**
 * AI に渡す本文の種類と優先順。ブログは body、トークは message_body、番組は transcript か description。
 * 同じアセットに複数あれば先のものを使う (`pickText`)
 */
const TEXT_TYPES_FOR_AI: TextType[] = ["body", "message_body", "transcript", "description"];

/** AI に渡す本文と人物 */
const ASSET_SELECT_WITH_TEXTS = {
  ...ASSET_SELECT,
  texts: {
    where: { textType: { in: TEXT_TYPES_FOR_AI } },
    select: { textType: true, content: true },
    orderBy: { createdAt: "asc" },
  },
  entities: {
    where: { entity: { type: "person" } },
    select: { entity: { select: { canonicalName: true } } },
  },
} satisfies Prisma.AssetSelect;

function pickText(texts: { textType: TextType; content: string }[] | undefined): string | null {
  if (!texts) return null;
  for (const type of TEXT_TYPES_FOR_AI) {
    const hit = texts.find((t) => t.textType === type && t.content.trim());
    // ブログ本文の画像の位置印 `{{IMG:<assetId>}}` は AI には雑音なので落とす
    if (hit) return hit.content.replace(/\{\{IMG:[A-Za-z0-9_-]+\}\}/g, "");
  }
  return null;
}

/** ブログの URL か (本人 / 他メンバー / ひなたぼっこ日記) */
function isBlogUrl(url: string | null | undefined): boolean {
  return !!url && /hinatazaka46\.com\/s\/official\/diary\//.test(url);
}

function dossierSelect<A extends Prisma.AssetSelect>(asset: A) {
  return {
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
        asset: { select: asset },
      },
    },
    placeCandidates: {
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        name: true,
        placeId: true,
        latitude: true,
        longitude: true,
        address: true,
        googleMapsUrl: true,
        note: true,
        place: { select: { classification: true, entity: { select: { canonicalName: true } } } },
      },
    },
  } satisfies Prisma.DossierSelect;
}

/**
 * ドシエとアイテムを読む。見えなければ null (権限か削除。呼び出し側が入力エラーにする)。
 * `withTexts` は本文を AI が書くテンプレートのときだけ (本文全文と人物エンティティを一緒に引く)
 */
export async function loadDossierForArticle(
  tx: TransactionClient,
  dossierId: string,
  options: {
    /** 本文全文と人物を読む (AI に書かせるとき) */
    withTexts?: boolean;
    /**
     * 画像しか入っていないブログの本文アセットを出典の宛先として足す (本文を AI が書くテンプレート)。
     * **保存時も同じにする** (プレビューと出典がずれないように)。本文は `withTexts` のときだけ読む
     */
    withExtraBlogTexts?: boolean;
  } = {}
): Promise<DossierForMaterials | null> {
  // select を条件で組むと Prisma の型推論が崩れるので、2 本に分けて書く
  const dossier = options.withTexts
    ? await tx.dossier.findUnique({ where: { id: dossierId }, select: dossierSelect(ASSET_SELECT_WITH_TEXTS) })
    : await tx.dossier.findUnique({ where: { id: dossierId }, select: dossierSelect(ASSET_SELECT) });
  if (!dossier) return null;
  const { _count, ...rest } = dossier;
  if (!options.withExtraBlogTexts) return { ...rest, itemCount: _count.items };

  // 画像しか入っていないブログの本文を同じ URL の text アセットから引く。RLS 下なので見えない分は
  // 落ち、機密の上限は where にも入れる (読めても外に出せないものをメモリに載せない)
  const urlsWithText = new Set<string>();
  const urlsWithoutText = new Set<string>();
  for (const item of dossier.items) {
    const a = item.asset;
    const url = a?.sourceRecords[0]?.url;
    if (!a || !url || !isBlogUrl(url)) continue;
    if (a.kind === "text") urlsWithText.add(url);
    else urlsWithoutText.add(url);
  }
  const missing = [...urlsWithoutText].filter((u) => !urlsWithText.has(u));
  if (missing.length === 0) return { ...rest, itemCount: _count.items, extraTextAssets: [] };

  const where = {
    kind: "text" as const,
    classification: { in: [...EXTERNAL_AI_OK] as ClearanceLevel[] },
    sourceRecords: { some: { url: { in: missing } } },
  };
  const found = options.withTexts
    ? await tx.asset.findMany({ where, select: ASSET_SELECT_WITH_TEXTS, orderBy: { createdAt: "asc" } })
    : await tx.asset.findMany({ where, select: ASSET_SELECT, orderBy: { createdAt: "asc" } });
  // 同じ URL に本文アセットが複数あれば古い 1 件だけ (出典の宛先と AI に渡す本文を 1 つに)
  const byUrl = new Map<string, (typeof found)[number]>();
  for (const a of found) {
    const url = a.sourceRecords[0]?.url;
    if (url && !byUrl.has(url)) byUrl.set(url, a);
  }
  return { ...rest, itemCount: _count.items, extraTextAssets: [...byUrl.values()] };
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
  /** 場所候補 (おでかけ記事の `locations`) */
  places: DossierPlace[];
  /** 機密レベルで落としたアセットの数 */
  droppedByClearance: number;
}

type LoadedAsset = NonNullable<DossierForMaterials["items"][number]["asset"]>;

/** 読んだアセットを組み立ての入力に (`texts` があるとき = AI のテンプレートは本文・人物も付ける) */
function toAssetInput(a: LoadedAsset, item: { excerpt?: string; caption?: string }): ArticleAssetInput {
  const src = a.sourceRecords[0];
  return {
    id: a.id,
    kind: a.kind,
    title: a.title,
    // UTC で切ると JST 0〜9 時のものが前日に落ちる
    canonicalDate: toJstDateOnly(a.canonicalDate),
    // 並べ替えは時刻まで見る (日付だけだと同じ日のトークが同着になる)
    sortAt: a.canonicalDate ? a.canonicalDate.toISOString() : null,
    source: src
      ? { kind: src.sourceKind, title: src.title, url: src.url, publishedAt: toJstDateOnly(src.publishedAt) }
      : null,
    excerpts: item.excerpt ? [item.excerpt] : [],
    ...(a.texts !== undefined
      ? {
          text: pickText(a.texts),
          caption: item.caption || undefined,
          people: (a.entities ?? []).map((e) => e.entity.canonicalName),
        }
      : {}),
  };
}

/** ドシエのアイテムを組み立ての入力に振り分ける (純粋関数) */
export function shapeDossierMaterials(dossier: DossierForMaterials): DossierMaterials {
  // アセットを 1 件にまとめる (同じアセットが抜粋ごとに複数 item になる)
  const assets = new Map<string, ArticleAssetInput>();
  const dropped = new Set<string>();
  const reports: string[] = [];
  const tiktoks: string[] = [];
  let dossierThumb: string | null = null;

  /**
   * 本文に載せてよいか。AI に渡す経路 (`texts` を読んでいる) は外部に出す上限も見る。
   * 今はどちらも internal で同じだが、片方だけ上げたときに AI の側が黙って追随しないように
   */
  const allowed = (a: LoadedAsset) =>
    PUBLISHABLE.has(a.classification) && (a.texts === undefined || EXTERNAL_AI_OK.has(a.classification));

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
    if (!allowed(a)) {
      dropped.add(a.id);
      continue;
    }
    const existing = assets.get(a.id);
    if (existing) {
      if (item.excerpt) existing.excerpts.push(item.excerpt);
      continue;
    }
    assets.set(a.id, toAssetInput(a, item));
  }

  // 画像しか入っていないブログの本文 (AI のテンプレートだけ)。ブログのグループに合流して出典の宛先になる。
  // 人が入れたアイテムではないので、落としても `droppedByClearance` には数えない
  for (const a of dossier.extraTextAssets ?? []) {
    if (assets.has(a.id) || !allowed(a)) continue;
    assets.set(a.id, toAssetInput(a, {}));
  }

  return {
    assets: [...assets.values()],
    reports,
    tiktoks,
    dossierThumb,
    places: dossier.placeCandidates.flatMap((p) => {
      // 昇格済みの候補は聖地 (Place) の機密で判定する。見えない (RLS) / 本文に載せられない聖地の名前・座標を
      // 公開記事や AI に出さない。座標へのフォールバックもしない (同じ場所なので)
      if (p.placeId && (!p.place || !PUBLISHABLE.has(p.place.classification))) return [];
      // 名前は画面と同じく聖地のエンティティ名を優先 (候補の name が空のまま昇格したものがある)
      const name = (p.place?.entity.canonicalName || p.name).trim();
      if (!name) return [];
      return [
        {
          name,
          placeId: p.placeId,
          lat: p.latitude,
          lng: p.longitude,
          address: p.address,
          googleMapsUrl: p.googleMapsUrl,
          note: p.note,
        },
      ];
    }),
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
