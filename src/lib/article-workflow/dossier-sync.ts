/**
 * 記事の出典 (`ArticleSource`) を記事の企画 (`Article.dossierId` → `DossierItem`) に写す計画 (#337)。
 * DB に触らない純粋関数。書くのは `src/lib/domain/article-dossier-sync.ts`。
 *
 * 企画は記事の素材置き場で、「反映待ち」(`dossier-sync-queue.ts`) は「企画にあって記事の出典に無い」
 * ものを数える。出典を足す経路 (画面・API・bot・取り込み) が企画を見ていなかったので、記事側にだけ
 * 出典が増えて企画とずれていた。
 *
 * - **足す**: 記事の出典のうち、企画に同じアセット (無ければ URL) のアイテムが無いもの。
 *   候補 (pending) の出典も足す。記事出典 (`refArticleId`) は素材ではないので足さない
 * - **企画より機密レベルが上の出典は足さない。** `DossierItem` は企画の classification だけで
 *   見え方が決まる (RLS) ので、題・抜粋が企画の閲覧者に漏れる
 * - **外す**: 記事から外した出典に当たるアイテム。そのまま残すと反映待ちに出てしまう。
 *   - 中身が出典の写しのまま (メモ・抜粋が空か、出典と同じ) なら消す
 *   - 人がメモ・抜粋を書いたものは消さずに「記事に足さない」(除外キー) を付ける
 *   - 外した後も同じアセット / URL の出典が残っているなら何もしない
 */

import type { TextType } from "@prisma/client";
import { isAboveClearance } from "@/lib/classification";
import { exclusionKey } from "@/lib/meetgreet/append";
import { shortIdFromArticleSourceUrl } from "@/lib/articles/source-article";

export interface SyncSource {
  assetId: string | null;
  url: string | null;
  refArticleId: string | null;
  label: string;
  excerpt: string;
  excerptType: TextType | null;
  excerptStart: number | null;
  excerptEnd: number | null;
  note: string;
  classification: string;
  /** RLS をバイパスして引いた元アセット。消されていれば null */
  asset: { title: string; classification: string } | null;
}

export interface SyncItem {
  id: string;
  assetId: string | null;
  externalUrl: string | null;
  excerpt: string;
  note: string;
}

export interface NewDossierItem {
  kind: "asset_ref" | "external_link";
  assetId: string | null;
  externalUrl: string | null;
  caption: string;
  excerpt: string;
  excerptType: TextType | null;
  excerptStart: number | null;
  excerptEnd: number | null;
  note: string;
}

/**
 * 素材としての同一性。アセットがあればアセット、無ければ URL。記事出典と、どちらも無い行は null。
 * 記事出典は `refArticleId` が埋まる前 (参照先を同じ取り込みで作った等) もあるので URL の形でも見る
 */
export function sourceKey(s: Pick<SyncSource, "assetId" | "url" | "refArticleId">): string | null {
  if (s.refArticleId || shortIdFromArticleSourceUrl(s.url?.trim())) return null;
  if (s.assetId) return `asset:${s.assetId}`;
  const url = s.url?.trim();
  return url ? `url:${url}` : null;
}

export function itemKey(i: Pick<SyncItem, "assetId" | "externalUrl">): string | null {
  if (i.assetId) return `asset:${i.assetId}`;
  const url = i.externalUrl?.trim();
  return url ? `url:${url}` : null;
}

export interface AdditionPlan {
  add: NewDossierItem[];
  /** 企画より機密レベルが上で足さなかった出典 */
  skippedAbove: SyncSource[];
}

/**
 * `limit` は企画を見られる人の下限。企画の classification と、**所有者のクリアランスの低い方**を渡す
 * (所有者は自分の企画をクリアランスに関係なく見られる。RLS の `dossier_select`)
 */
export function planDossierAdditions(
  sources: SyncSource[],
  items: SyncItem[],
  limit: string
): AdditionPlan {
  const have = new Set(items.map(itemKey).filter((k): k is string => !!k));
  const add: NewDossierItem[] = [];
  const skippedAbove: SyncSource[] = [];
  for (const s of sources) {
    const key = sourceKey(s);
    if (!key || have.has(key)) continue;
    const levels = [s.classification, ...(s.asset ? [s.asset.classification] : [])];
    if (levels.some((l) => isAboveClearance(l, limit))) {
      // 同じアセットの後の行 (機密の低い抜粋) は足せるので、ここでは have に入れない
      skippedAbove.push(s);
      continue;
    }
    have.add(key);
    add.push({
      kind: s.assetId ? "asset_ref" : "external_link",
      assetId: s.assetId,
      externalUrl: s.assetId ? null : s.url!.trim(),
      caption: s.label || s.asset?.title || s.url || "",
      excerpt: s.excerpt,
      excerptType: s.excerptType,
      excerptStart: s.excerptStart,
      excerptEnd: s.excerptEnd,
      note: s.note,
    });
  }
  return { add, skippedAbove };
}

export interface RemovalPlan {
  deleteItemIds: string[];
  /** 企画 (器があれば器) の `articleExclusions` に足すキー */
  exclusionKeys: string[];
}

export type RemovedSource = Pick<SyncSource, "assetId" | "url" | "refArticleId" | "excerpt" | "note">;

export function planDossierRemovals(
  removed: RemovedSource[],
  remaining: Pick<SyncSource, "assetId" | "url" | "refArticleId">[],
  items: SyncItem[]
): RemovalPlan {
  const still = new Set(remaining.map(sourceKey).filter((k): k is string => !!k));
  const gone = new Map<string, RemovedSource[]>();
  for (const s of removed) {
    const key = sourceKey(s);
    if (!key || still.has(key)) continue;
    gone.set(key, [...(gone.get(key) ?? []), s]);
  }
  const deleteItemIds: string[] = [];
  const exclusionKeys = new Set<string>();
  for (const i of items) {
    const key = itemKey(i);
    const from = key ? gone.get(key) : undefined;
    if (!from) continue;
    const blank = !i.note.trim() && !i.excerpt.trim();
    const copied = from.some((s) => s.excerpt === i.excerpt && s.note === i.note);
    if (blank || copied) {
      deleteItemIds.push(i.id);
      continue;
    }
    // 人が書いたメモ・抜粋は残し、反映待ちに出ないよう「足さない」にする。
    // 外部リンクは反映待ちの対象外 (`judgeCitation` が ignored) なので印は要らない
    if (i.assetId) {
      exclusionKeys.add(exclusionKey("source", i.assetId));
      if (i.excerpt.trim()) exclusionKeys.add(exclusionKey("quote", i.excerpt));
    }
  }
  return { deleteItemIds, exclusionKeys: [...exclusionKeys] };
}
