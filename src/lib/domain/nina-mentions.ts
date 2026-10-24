/**
 * 「本文が坂井新奈に言及しているか」(Asset.mentionsNina) の付け外し。
 *
 * /progress と /coverage の関連判定 (getSourceMentionKeys) は、これまで開くたびに AssetText
 * 全体を名前・別名で検索していた (冷えた DB で約 3.6 秒)。結果をアセットに溜めておき、判定は
 * 列を見るだけにする。15 分ごとの cron と CLI から呼ぶ。
 *
 * 毎回全件を検索し直して差分だけ書く (PGroonga で約 1.4 秒)。本文の編集・別名の追加・
 * アセットの削除にも追従でき、「前回以降の新着」を覚えておく必要が無い。
 *
 * 全アセットを見るので RLS をバイパスする prismaInternal で呼ぶ (CLI・全体統計と同じ扱い)。
 */
import { Prisma } from "@prisma/client";
import type { TransactionClient } from "@/lib/db";
import { normalizeText } from "@/lib/utils";
import { getNinaEntity } from "./coverage-items";

export interface NinaMentionRefresh {
  terms: string[];
  /** 本文が一致したアセット数 */
  matched: number;
  /** false → true にする (した) アセットの id */
  added: string[];
  /** true → false にする (した) アセットの id */
  removed: string[];
}

/** 本文が名前・別名のどれかに一致するアセットの id。索引は normalizedContent 側なので語も正規化する */
export async function findNinaMentionAssetIds(db: TransactionClient, terms: string[]): Promise<string[]> {
  if (!terms.length) return [];
  const conds = terms.map((t) => Prisma.sql`"normalizedContent" &@ ${normalizeText(t)}`);
  const rows = await db.$queryRaw<{ assetId: string }[]>`
    SELECT DISTINCT "assetId" FROM "AssetText" WHERE ${Prisma.join(conds, " OR ")}
  `;
  return rows.map((r) => r.assetId);
}

export async function refreshNinaMentions(db: TransactionClient, { apply }: { apply: boolean }): Promise<NinaMentionRefresh> {
  const entity = await getNinaEntity(db);
  // エンティティが引けないときに全件を false へ倒さない (判定できないだけで、言及が消えたわけではない)
  if (!entity) throw new Error("坂井新奈のエンティティが見つかりません");
  const [matched, current] = await Promise.all([
    findNinaMentionAssetIds(db, entity.terms),
    db.asset.findMany({ where: { mentionsNina: true }, select: { id: true } }),
  ]);
  const matchedSet = new Set(matched);
  const currentSet = new Set(current.map((a) => a.id));
  // 検索が 0 件なのに印が付いているのは、索引の作り直しなどで検索が壊れたときに起きる。
  // そのまま書くと全件の印を無言で外し、/progress と /coverage の分母が縮むので止める
  if (!matched.length && currentSet.size) throw new Error(`本文検索が 0 件です (印の付いたアセット ${currentSet.size} 件)。検索の故障とみなして書き込みません`);
  const added = matched.filter((id) => !currentSet.has(id));
  const removed = [...currentSet].filter((id) => !matchedSet.has(id));
  if (apply) {
    // updatedAt は「アセットを編集した日時」なので進めない (一覧の並びや同期の判定を動かさない)
    for (const [ids, value] of [[added, true], [removed, false]] as const) {
      for (let i = 0; i < ids.length; i += 1000) {
        await db.$executeRaw`UPDATE "Asset" SET "mentionsNina" = ${value} WHERE id = ANY(${ids.slice(i, i + 1000)})`;
      }
    }
  }
  return { terms: entity.terms, matched: matched.length, added, removed };
}
