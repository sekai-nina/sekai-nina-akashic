/**
 * 素材の言及・著者の判定（/progress の素材進捗と言及の付け直しが使う）。
 *
 * 坂井新奈エンティティ（type=person, canonicalName='坂井新奈'）は Entity テーブルから引く
 * （ハードコードしない）。canonicalName + aliases を一致語に使う。
 * ソース全体の「言及あり / 本人著」キー集合は数分キャッシュする。
 *
 * 旧 `/coverage/items` のトリアージ一覧（listItems）は #253 で撤去した。
 */

import { Prisma } from "@prisma/client";
import { unstable_cache } from "next/cache";
import { withClearance, type TransactionClient } from "@/lib/db";
import { itemRuleIsUrl, sourcePatternConds } from "./coverage";

// ============================================================
// 坂井新奈エンティティ（Entity テーブルから引く。ハードコードしない）
// ============================================================

interface NinaEntity {
  id: string;
  terms: string[]; // canonicalName + aliases
}

export async function getNinaEntity(tx: TransactionClient): Promise<NinaEntity | null> {
  const e = await tx.entity.findUnique({
    where: { type_canonicalName: { type: "person", canonicalName: "坂井新奈" } },
    select: { id: true, canonicalName: true, aliases: true },
  });
  if (!e) return null;
  const aliases = Array.isArray(e.aliases)
    ? (e.aliases as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  const terms = Array.from(new Set([e.canonicalName, ...aliases].filter(Boolean)));
  return { id: e.id, terms };
}

/**
 * 坂井新奈の一致語彙（canonicalName + aliases）を返す（アセットページの言及ハイライト用）。
 * 長い語を先に並べる（正規表現の交替で「坂井新奈」が「坂井」「新奈」より優先されるように）。
 */
export async function getNinaTerms(clearance: string): Promise<string[]> {
  return withClearance(clearance, async (tx) => {
    const entity = await getNinaEntity(tx);
    return (entity?.terms ?? []).slice().sort((a, b) => b.length - a.length);
  });
}

// ============================================================
// ソース全体の言及ありキー集合（url 系のみ・数分キャッシュ）
// ============================================================

async function computeSourceMentionKeys(clearance: string, sourceKey: string): Promise<string[]> {
  return withClearance(
    clearance,
    async (tx) => {
    const ds = await tx.dataSource.findUnique({ where: { key: sourceKey } });
    if (!ds || !itemRuleIsUrl(ds.itemRule)) return [];
    const entity = await getNinaEntity(tx);
    if (!entity) return [];

    const whereBase = Prisma.join(
      [Prisma.sql`sr.url IS NOT NULL AND sr.url <> ''`, ...sourcePatternConds(ds)],
      " AND "
    );

    // (a) 坂井新奈への AssetEntity リンクを持つアセットの url
    const aRows = await tx.$queryRaw<{ itemKey: string }[]>`
      SELECT DISTINCT sr.url AS "itemKey"
      FROM "SourceRecord" sr
      JOIN "AssetEntity" ae ON ae."assetId" = sr."assetId"
      WHERE ${whereBase} AND ae."entityId" = ${entity.id}
    `;

    // (b) 本文が canonicalName/aliases のいずれかに一致するアセットの url。
    // 本文検索は開くたびに走らせると冷えた DB で約 3.6 秒かかるので、結果を Asset.mentionsNina に
    // 溜めてある (15 分ごとの cron。src/lib/domain/nina-mentions.ts)。一致するアセットは千件前後なので、
    // MATERIALIZED CTE で先に確定させてから SourceRecord を引く (逆順だとソース全体を舐める)。
    const bRows = await tx.$queryRaw<{ itemKey: string }[]>`
      WITH hits AS MATERIALIZED (
        SELECT a.id FROM "Asset" a WHERE a."mentionsNina"
      )
      SELECT DISTINCT sr.url AS "itemKey"
      FROM "SourceRecord" sr
      JOIN hits ON hits.id = sr."assetId"
      WHERE ${whereBase}
    `;

    const set = new Set<string>();
    for (const r of aRows) set.add(r.itemKey);
    for (const r of bRows) set.add(r.itemKey);
    return Array.from(set);
    }
  );
}

/**
 * ソース全体の「坂井新奈への言及あり」itemKey 集合を返す（url 系のみ非空）。
 * 言及フィルタのページング母集団・行の言及バッジ・bulk の onlyMentionless で共有する。
 * unstable_cache で 120 秒キャッシュ（source×clearance でキー）。内部管理画面なので許容。
 */
export async function getSourceMentionKeys(sourceKey: string, clearance: string): Promise<string[]> {
  const cached = unstable_cache(
    () => computeSourceMentionKeys(clearance, sourceKey),
    ["coverage-mention-keys", sourceKey, clearance],
    { revalidate: 120, tags: ["coverage-mention-keys"] }
  );
  return cached();
}

// ============================================================
// ソース全体の「坂井新奈が著者」キー集合（v2.4・url 系のみ・数分キャッシュ)
// ============================================================

async function computeSourceAuthorKeys(clearance: string, sourceKey: string): Promise<string[]> {
  // AssetEntity(entityId, roleLabel='author') の等値結合のみ（本文スキャン無し）で軽い。
  return withClearance(clearance, async (tx) => {
    const ds = await tx.dataSource.findUnique({ where: { key: sourceKey } });
    if (!ds || !itemRuleIsUrl(ds.itemRule)) return [];
    const entity = await getNinaEntity(tx);
    if (!entity) return [];

    const whereBase = Prisma.join(
      [Prisma.sql`sr.url IS NOT NULL AND sr.url <> ''`, ...sourcePatternConds(ds)],
      " AND "
    );
    const rows = await tx.$queryRaw<{ itemKey: string }[]>`
      SELECT DISTINCT sr.url AS "itemKey"
      FROM "SourceRecord" sr
      JOIN "AssetEntity" ae ON ae."assetId" = sr."assetId"
      WHERE ${whereBase} AND ae."entityId" = ${entity.id} AND ae."roleLabel" = 'author'
    `;
    return rows.map((r) => r.itemKey);
  });
}

/**
 * ソース全体の「坂井新奈が著者（roleLabel='author'）」itemKey 集合を返す（url 系のみ非空）。
 * 本人ブログには本人への言及が無いことがあるため、関連判定は 言及 ∪ 本人著 の2軸（v2.4）。
 * getSourceMentionKeys と同構造・同キャッシュ方式（120秒・source×clearance キー）。
 */
export async function getSourceAuthorKeys(sourceKey: string, clearance: string): Promise<string[]> {
  const cached = unstable_cache(
    () => computeSourceAuthorKeys(clearance, sourceKey),
    ["coverage-author-keys", sourceKey, clearance],
    { revalidate: 120, tags: ["coverage-author-keys"] }
  );
  return cached();
}
