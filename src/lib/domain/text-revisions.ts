/**
 * 本文の版と、出典キーからのアセット照会 (#262)。
 *
 * bot は毎日公式のブログ一覧・トークと akashic を突き合わせる。
 * - 照会 (`lookupSourceAssets`): ブログの URL / トークのメッセージ ID ごとに、登録済みのアセットと本文を返す。
 *   bot は本文が無いものを取り直し、本文が違うものは版を送る
 * - 版 (`addTextRevision`): 送られた本文が現行と違えば、旧版を `AssetTextRevision` に残して `AssetText` を
 *   書き換える。`AssetText` は常に最新版なので、検索・記事化など既存の読み手は版を意識しない
 *
 * UI の手編集 (`texts.ts` の `updateText`) は版にしない (誤字直しまで版になるのを避ける)。
 */
import { Prisma, type TextType } from "@prisma/client";
import { prismaInternal, withClearance } from "@/lib/db";
import { normalizeText } from "@/lib/utils";
import { relocateExcerpt } from "./text-revision-relocate";

// ============================================================
// 版
// ============================================================

export type AddTextRevisionResult =
  /** 同じ textType の本文がまだ無かったので作った (版は積まない) */
  | { status: "created"; assetTextId: string }
  /** 現行と同じだった */
  | { status: "unchanged"; assetTextId: string; version: number }
  /** 新しい版として積んだ。`relocatedExcerpts` は範囲を探し直せた抜粋の数、`unlocatedExcerpts` は見つからなかった数 */
  | {
      status: "revised";
      assetTextId: string;
      version: number;
      relocatedExcerpts: number;
      unlocatedExcerpts: number;
    };

/**
 * 本文を新しい版として積む。アセットが見えない (RLS) なら null。
 *
 * 同じ textType のテキストが複数あるときは最初に作られたものを対象にする (bot の登録は 1 つ)。
 * 初めて版を積むときは、それまでの本文を version 1 (fetchedAt = AssetText.createdAt) として種まきする。
 * 最新版のあとに画面で手編集されていたら、その本文も版として残してから新しい版を積む (上書きで消さない)。
 *
 * 同じアセットへの同時 POST は Asset 行のロックで直列にする (版番号の取り合い・本文テキストの二重作成を防ぐ)。
 */
export async function addTextRevision(
  input: { assetId: string; textType: TextType; content: string; fetchedAt: Date },
  clearance: string
): Promise<AddTextRevisionResult | null> {
  const result = await withClearance(clearance, async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Asset" WHERE id = ${input.assetId} FOR UPDATE`;
    if (locked.length === 0) return null;

    const current = await tx.assetText.findFirst({
      where: { assetId: input.assetId, textType: input.textType },
      orderBy: { createdAt: "asc" },
      select: { id: true, content: true, createdAt: true, updatedAt: true },
    });
    if (!current) {
      const created = await tx.assetText.create({
        data: {
          assetId: input.assetId,
          textType: input.textType,
          content: input.content,
          normalizedContent: normalizeText(input.content),
          language: "ja",
        },
        select: { id: true },
      });
      return { status: "created" as const, assetTextId: created.id };
    }

    const latest = await tx.assetTextRevision.findFirst({
      where: { assetTextId: current.id },
      orderBy: { version: "desc" },
      select: { version: true, content: true },
    });
    if (current.content === input.content) {
      return { status: "unchanged" as const, assetTextId: current.id, version: latest?.version ?? 1 };
    }

    const addRevision = (version: number, content: string, fetchedAt: Date) =>
      tx.assetTextRevision.create({
        data: { assetId: input.assetId, assetTextId: current.id, version, content, fetchedAt },
      });
    let version = latest?.version ?? 0;
    if (!latest) {
      await addRevision(++version, current.content, current.createdAt);
    } else if (latest.content !== current.content) {
      await addRevision(++version, current.content, current.updatedAt);
    }
    await addRevision(++version, input.content, input.fetchedAt);
    await tx.assetText.update({
      where: { id: current.id },
      data: { content: input.content, normalizedContent: normalizeText(input.content) },
    });
    return { status: "revised" as const, assetTextId: current.id, version };
  });

  if (result?.status !== "revised") return result;
  const { relocated, unlocated } = await relocateExcerpts(input.assetId, input.textType, input.content);
  return { ...result, relocatedExcerpts: relocated, unlocatedExcerpts: unlocated };
}

/**
 * 本文が変わったアセットの抜粋 (DossierItem = クリップ、ArticleSource = 記事の出典) の範囲を新本文で探し直す。
 * 抜粋の文字列は変えず、範囲だけ書き換える (記事の push 出力には範囲は載らないので dirty は立てない)。
 *
 * `prismaInternal` (RLS バイパス) で引く。`withClearance` だと app.user_id が無く、他人の private な
 * ドシエのクリップや、API キーより上の機密の出典が見えずに取り残される。触るのは範囲だけで、
 * 呼び出し側に返すのは件数だけ。版を積んだトランザクションの後に走るので、ここで落ちても版は残る
 * (範囲がずれたままになり、アセット詳細で「位置未確定」になるだけ)。
 */
async function relocateExcerpts(
  assetId: string,
  textType: TextType,
  content: string
): Promise<{ relocated: number; unlocated: number }> {
  const where = { assetId, excerptType: textType, excerptStart: { not: null }, excerptEnd: { not: null } };
  const select = { id: true, excerpt: true, excerptStart: true, excerptEnd: true } as const;
  const [items, sources] = await Promise.all([
    prismaInternal.dossierItem.findMany({ where, select }),
    prismaInternal.articleSource.findMany({ where, select }),
  ]);

  let relocated = 0;
  let unlocated = 0;
  const plan = (row: { excerpt: string; excerptStart: number | null; excerptEnd: number | null }) => {
    const r = relocateExcerpt(content, row.excerpt, row.excerptStart ?? -1, row.excerptEnd ?? -1);
    if (r === "keep") return null;
    if (!r) {
      unlocated++;
      return null;
    }
    relocated++;
    return { excerptStart: r.start, excerptEnd: r.end };
  };
  for (const item of items) {
    const data = plan(item);
    if (data) await prismaInternal.dossierItem.update({ where: { id: item.id }, data });
  }
  for (const source of sources) {
    const data = plan(source);
    if (data) await prismaInternal.articleSource.update({ where: { id: source.id }, data });
  }
  return { relocated, unlocated };
}

/** アセットの本文の版。テキストごとにまとめ、その中で新しい順。版が無いテキストは含まない */
export async function listTextRevisions(assetId: string, clearance: string) {
  return withClearance(clearance, (tx) =>
    tx.assetTextRevision.findMany({
      where: { assetId },
      orderBy: [{ assetTextId: "asc" }, { version: "desc" }],
      select: { id: true, assetTextId: true, version: true, content: true, fetchedAt: true },
    })
  );
}

// ============================================================
// 出典キーからの照会
// ============================================================

/** 照会で返す本文の textType。ブログは body、トークは message_body */
const LOOKUP_TEXT_TYPES: TextType[] = ["body", "message_body"];

export interface LookupAsset {
  id: string;
  kind: string;
  title: string;
  /** body / message_body。無ければ空配列 (= 本文が欠けている) */
  texts: { textType: TextType; content: string }[];
}

export interface LookupResult {
  /** 照会した URL → その URL を出典に持つアセット。無ければ空配列 */
  urls: Record<string, LookupAsset[]>;
  /** 照会したトークのメッセージ ID → そのメッセージのアセット。無ければ空配列 */
  talkMessageIds: Record<string, LookupAsset[]>;
}

export const LOOKUP_MAX_KEYS = 500;

/**
 * ブログの URL (SourceRecord.url の完全一致) とトークのメッセージ ID (SourceRecord.metadata.talk_message_id) から
 * 登録済みのアセットを引く。見えないアセット (RLS) は無いものとして返す。
 *
 * キー → assetId の解決だけは `prismaInternal` (RLS バイパス) で引く。talk_message_id には索引が無く、
 * RLS の下では行ごとにポリシーの副問い合わせが走って 14 万行の seq scan が 12 秒かかった
 * (`->>` が leakproof でないので絞り込みをポリシーより先に評価できない)。バイパスなら 70ms。
 * 返すアセットは `withClearance` で引き直すので、見えないアセットの中身は出ない。
 */
export async function lookupSourceAssets(
  input: { urls: string[]; talkMessageIds: string[] },
  clearance: string
): Promise<LookupResult> {
  const urls = [...new Set(input.urls)];
  const talkIds = [...new Set(input.talkMessageIds)];

  const [byUrl, byTalk] = await Promise.all([
    urls.length
      ? prismaInternal.sourceRecord.findMany({ where: { url: { in: urls } }, select: { assetId: true, url: true } })
      : [],
    talkIds.length
      ? prismaInternal.$queryRaw<{ assetId: string; talkMessageId: string }[]>`
          SELECT "assetId", metadata->>'talk_message_id' AS "talkMessageId"
          FROM "SourceRecord"
          WHERE metadata->>'talk_message_id' IN (${Prisma.join(talkIds)})`
      : [],
  ]);

  return withClearance(clearance, async (tx) => {
    const assetIds = [...new Set([...byUrl.map((r) => r.assetId), ...byTalk.map((r) => r.assetId)])];
    const assets = assetIds.length
      ? await tx.asset.findMany({
          where: { id: { in: assetIds } },
          select: {
            id: true,
            kind: true,
            title: true,
            texts: {
              where: { textType: { in: LOOKUP_TEXT_TYPES } },
              orderBy: { createdAt: "asc" },
              select: { textType: true, content: true },
            },
          },
          orderBy: { createdAt: "asc" },
        })
      : [];
    const assetById = new Map(assets.map((a) => [a.id, a]));

    const group = <K extends string>(keys: string[], rows: { assetId: string; key: K | null }[]) => {
      const out: Record<string, LookupAsset[]> = Object.fromEntries(keys.map((k) => [k, []]));
      for (const row of rows) {
        const asset = assetById.get(row.assetId);
        if (!asset || row.key == null || !out[row.key]) continue;
        if (!out[row.key].some((a) => a.id === asset.id)) out[row.key].push(asset);
      }
      return out;
    };

    return {
      urls: group(urls, byUrl.map((r) => ({ assetId: r.assetId, key: r.url }))),
      talkMessageIds: group(talkIds, byTalk.map((r) => ({ assetId: r.assetId, key: r.talkMessageId }))),
    };
  });
}
