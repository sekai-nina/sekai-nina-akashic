/**
 * 記事ワークフロー (ミーグリ #106 / ライブ #148) が共有する部品。
 *
 * どちらも「素材置き場のドシエ + X レポの収集 + 生成した記事」を 1 行で束ねる器で、
 * 一覧の進み具合・素材候補の引き方・ドシエへの反映は同じ。器ごとの違い (日付の窓、
 * キーワード、名前の付け方) は各ドメイン層 (meetgreets.ts / lives.ts) が持ち、ここは
 * 器を知らない関数だけを置く。
 *
 * すべて呼び出し側の withSession の中 (`tx`) で動く前提 (ドシエは所有者判定が要る)。
 */

import type { ArticleTemplate, Prisma } from "@prisma/client";
import { prisma, withSession, type TransactionClient } from "@/lib/db";
import { ARTICLE_TEMPLATE_LABELS } from "@/lib/utils";
import { canEditDossier } from "@/lib/auth/dossier-permissions";
import type { CandidateAssetInput } from "@/lib/meetgreet/candidates";

export interface ActingUser {
  id: string;
  role: string;
  clearance: string;
}

/**
 * 入力が不正なことを呼び出し元 (REST の 400) に伝える。
 * 器ごとのエラー (`MeetGreetInputError` / `LiveInputError`) はこれを継承する
 */
export class WorkflowInputError extends Error {}

export interface DossierBrief {
  id: string;
  title: string;
  itemCount: number;
  updatedAt: Date;
}

/**
 * ドシエの編集権限を確かめる (呼び出し側の `withSession` の中で)。
 * 見えなければ `WorkflowInputError` (REST は 404)、編集できなければ "Access denied" の Error (403)。
 * RLS の `dossier_update` と同じ条件をアプリ層で先に見て、`update` が P2025 で落ちて 500 になるのを防ぐ
 */
export async function assertDossierEditable(
  tx: TransactionClient,
  user: ActingUser,
  dossierId: string
): Promise<void> {
  const dossier = await tx.dossier.findUnique({
    where: { id: dossierId },
    select: { ownerId: true, classification: true, viewMode: true, editMode: true },
  });
  if (!dossier) throw new WorkflowInputError("ドシエが見つかりません");
  if (!canEditDossier(user, dossier)) {
    throw new Error("Access denied: insufficient permission to edit this dossier");
  }
}

/**
 * 既にあるドシエ / X レポ収集を器に紐づける前の確認。見えること・**ミーグリにもライブにも**
 * まだ使われていないこと・クリップのプールでないこと (#41: 全員共有のプールを 1 つの器に
 * 紐づけると他人のクリップが素材として流れる)・記事テンプレート (#170) が別の型に決まって
 * いないことを確かめる。書かない (書くのは `claimDossierTemplate`)。
 *
 * 見えない器 (上位機密) に使われている場合はここでは分からず、`@unique` の違反で落ちる
 * (安全側。整合性は DB が守る)
 */
export async function assertContainersFree(
  tx: TransactionClient,
  input: { dossierId?: string; repoCollectionId?: string },
  template?: ArticleTemplate
): Promise<void> {
  if (input.dossierId) {
    const found = await tx.dossier.findUnique({
      where: { id: input.dossierId },
      select: {
        id: true,
        kind: true,
        articleTemplate: true,
        meetGreet: { select: { id: true } },
        live: { select: { id: true } },
      },
    });
    if (!found) throw new WorkflowInputError("指定されたドシエが見つかりません");
    if (found.meetGreet) throw new WorkflowInputError("そのドシエは別のミーグリに使われています");
    if (found.live) throw new WorkflowInputError("そのドシエは別のライブに使われています");
    if (found.kind === "clips") throw new WorkflowInputError("クリップのプールは素材置き場に使えません");
    if (template && found.articleTemplate && found.articleTemplate !== template) {
      throw new WorkflowInputError(
        `そのドシエは記事テンプレート「${ARTICLE_TEMPLATE_LABELS[found.articleTemplate]}」に決まっています`
      );
    }
  }
  if (input.repoCollectionId) {
    const found = await tx.repoCollection.findUnique({
      where: { id: input.repoCollectionId },
      select: { id: true, meetGreet: { select: { id: true } }, live: { select: { id: true } } },
    });
    if (!found) throw new WorkflowInputError("指定された X レポ収集が見つかりません");
    if (found.meetGreet) throw new WorkflowInputError("その収集は別のミーグリに使われています");
    if (found.live) throw new WorkflowInputError("その収集は別のライブに使われています");
  }
}

/**
 * 既にあるドシエを器に紐づけるとき、記事テンプレート (#170) を器の型にする
 * (`assertContainersFree` の後、同じトランザクションで)。既に同じ値なら何もしない。
 *
 * - **編集権限を先に見る。** 見えるが編集できないドシエ (`editMode: private` で所有者でない) を
 *   `tx.dossier.update` で書くと RLS で 0 行になり P2025 → 500 になる。器の作成が
 *   このドシエへの書き込みを要る以上、編集権限が無ければ入力エラーにする
 * - `updatedAt` は進めない (素の SQL)。記事の frontmatter の `dossier.updated_at` と比べて
 *   「要反映」を判定するので、素材が変わっていないのに動かさない
 */
export async function claimDossierTemplate(
  tx: TransactionClient,
  user: ActingUser,
  dossierId: string,
  template: ArticleTemplate
): Promise<void> {
  const found = await tx.dossier.findUnique({
    where: { id: dossierId },
    select: { articleTemplate: true, ownerId: true, classification: true, viewMode: true, editMode: true },
  });
  if (!found) throw new WorkflowInputError("指定されたドシエが見つかりません");
  if (found.articleTemplate === template) return;
  if (!canEditDossier(user, found)) {
    throw new WorkflowInputError("そのドシエの編集権限が無いので素材置き場にできません (所有者に編集を許可してもらってください)");
  }
  await tx.$executeRaw`UPDATE "Dossier" SET "articleTemplate" = ${template}::"ArticleTemplate" WHERE "id" = ${dossierId}`;
}

/**
 * ドシエは **include せず別に引く**。
 *
 * 器の `dossier` は必須リレーションだが、Dossier の RLS は owner / viewMode で別に判定される。
 * 作成時は `viewMode: clearance` にしているものの、所有者があとから private に戻したり機密を
 * 上げると、他の人には行が見えなくなる。必須リレーションを include したままだと Prisma が
 * "Field dossier is required to return data" を投げ、**その 1 行ではなく一覧全体が 500 になる**。
 * 見えないものは null にして画面で伝える。
 */
export async function loadDossiers(
  tx: TransactionClient,
  ids: string[]
): Promise<Map<string, DossierBrief>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.dossier.findMany({
    where: { id: { in: ids } },
    select: { id: true, title: true, updatedAt: true, _count: { select: { items: true } } },
  });
  return new Map(
    rows.map((d) => [d.id, { id: d.id, title: d.title, updatedAt: d.updatedAt, itemCount: d._count.items }])
  );
}

/** X レポ収集の keep / 取得数 */
export async function keepCounts(tx: TransactionClient, collectionIds: string[]) {
  if (collectionIds.length === 0) return new Map<string, { keep: number; total: number }>();
  const grouped = await tx.repoTweet.groupBy({
    by: ["collectionId", "status"],
    where: { collectionId: { in: collectionIds } },
    _count: { _all: true },
  });
  const counts = new Map<string, { keep: number; total: number }>();
  for (const g of grouped) {
    const c = counts.get(g.collectionId) ?? { keep: 0, total: 0 };
    c.total += g._count._all;
    if (g.status === "keep") c.keep += g._count._all;
    counts.set(g.collectionId, c);
  }
  return counts;
}

/**
 * 記事の frontmatter に書いてあるドシエのスナップショットと、いまのドシエを突き合わせて
 * 「要反映」を判定する (sekai-nina-site の `pnpm check:dossiers` を akashic 側に持ってきたもの)。
 *
 * Article は非保護テーブルなので素の prisma でよい。**トランザクションの外で呼ぶこと**
 * (中で別の接続を取ると 15,000ms の枠を食い、プールも 2 本使う)。
 */
export async function loadNeedsSync(
  articleIds: string[],
  dossiers: Map<string, DossierBrief>,
  dossierIdByArticleId: Map<string, string>
): Promise<Set<string>> {
  if (articleIds.length === 0) return new Set();
  const rows = await prisma.article.findMany({
    where: { id: { in: articleIds } },
    select: { id: true, frontmatterExtra: true },
  });
  const stale = new Set<string>();
  for (const row of rows) {
    const extra = row.frontmatterExtra;
    const snap =
      extra && typeof extra === "object" && !Array.isArray(extra)
        ? (extra as { dossier?: { item_count?: unknown; updated_at?: unknown } }).dossier
        : undefined;
    const dossierId = dossierIdByArticleId.get(row.id);
    const current = dossierId ? dossiers.get(dossierId) : undefined;
    if (!current) continue;
    // スナップショットが無い記事は判定できないので「要反映」にしない (毎回出続けるのを避ける)
    if (!snap) continue;
    const countChanged =
      typeof snap.item_count === "number" && snap.item_count !== current.itemCount;
    const updatedChanged =
      typeof snap.updated_at === "string" && new Date(snap.updated_at) < current.updatedAt;
    if (countChanged || updatedChanged) stale.add(row.id);
  }
  return stale;
}

// --- 素材候補 ---

export interface MaterialInputs {
  inputs: CandidateAssetInput[];
  /** 既にドシエに入っているアセット ID */
  inDossier: Set<string>;
  /** 運営ブログの URL → 本文 */
  staffTexts: Map<string, string>;
}

/**
 * 素材候補の元になるアセットを引く。どのアセットを候補にするか (日付の窓・エンティティ) は
 * `where` で呼び出し側が決め、ここは分類に要る形 (出典・本文・トークタグ) に揃えるだけ。
 *
 * 運営ブログ (ひなたぼっこ日記) の本文 text には本人の人物エンティティが付かないので、
 * 候補に出た運営ブログの URL について本文だけ別に引いてキーワード判定に使う。
 */
export async function loadMaterialInputs(
  tx: TransactionClient,
  where: Prisma.AssetWhereInput,
  dossierId: string
): Promise<MaterialInputs> {
  const [assets, inDossier] = await Promise.all([
    tx.asset.findMany({
      where,
      orderBy: { canonicalDate: "asc" },
      select: {
        id: true,
        kind: true,
        title: true,
        canonicalDate: true,
        thumbnailUrl: true,
        sourceRecords: { select: { url: true, title: true }, take: 1, orderBy: { createdAt: "asc" } },
        texts: {
          where: { textType: { in: ["body", "message_body"] } },
          select: { content: true },
          orderBy: { createdAt: "asc" },
          take: 1,
        },
        entities: {
          where: { entity: { type: "tag", canonicalName: "トーク" } },
          select: { entityId: true },
          take: 1,
        },
      },
    }),
    tx.dossierItem.findMany({
      where: { dossierId, assetId: { not: null } },
      select: { assetId: true },
    }),
  ]);

  const inputs: CandidateAssetInput[] = assets.map((a) => ({
    id: a.id,
    kind: a.kind,
    title: a.title,
    canonicalDate: a.canonicalDate,
    thumbnailUrl: a.thumbnailUrl,
    source: a.sourceRecords[0] ?? null,
    text: a.texts[0]?.content ?? null,
    hasTalkTag: a.entities.length > 0,
  }));

  // 運営ブログの本文 (本人タグ無し) を URL ごとに引く
  const staffUrls = [
    ...new Set(
      inputs.map((i) => i.source?.url ?? "").filter((u) => u.includes("/diary/manager/"))
    ),
  ];
  const staffTexts = new Map<string, string>();
  if (staffUrls.length > 0) {
    const staff = await tx.asset.findMany({
      where: { kind: "text", sourceRecords: { some: { url: { in: staffUrls } } } },
      select: {
        // 対象の URL を持つ出典に限る (別の出典が先頭だと違う URL で引いてしまう)
        sourceRecords: { where: { url: { in: staffUrls } }, select: { url: true }, take: 1 },
        texts: { where: { textType: "body" }, select: { content: true }, take: 1 },
      },
    });
    for (const s of staff) {
      const url = s.sourceRecords[0]?.url;
      const content = s.texts[0]?.content;
      if (url && content) staffTexts.set(url, content);
    }
  }

  return {
    inputs,
    inDossier: new Set(inDossier.flatMap((i) => (i.assetId ? [i.assetId] : []))),
    staffTexts,
  };
}

/**
 * チェックされたアセットをドシエに asset_ref で入れる。
 *
 * `addAssetItem` を 1 件ずつ呼ぶと 1 アセットあたり 2 トランザクション (権限チェック +
 * 追加) になり、30 件で数百クエリになる。権限は同じドシエに対して 1 回で足りるので、
 * ここでまとめて 1 トランザクションに収める。
 *
 * 既にドシエにあるアセットは飛ばす (`skipped`)。判定は候補側の `inDossier` と同じく
 * 「そのアセットの DossierItem があるか」で、抜粋付きで入っているものも「ある」として扱う
 * (画面でチェックできないものが REST から二重に入らないように)。
 *
 * ドシエが見えなければ `WorkflowInputError`、編集権限が無ければ "Access denied" の Error
 * (REST はそれぞれ 404 / 403 にする)。
 */
export async function applyMaterialsToDossier(
  user: ActingUser,
  dossierId: string,
  assetIds: string[]
): Promise<{ added: number; skipped: number }> {
  const ids = [...new Set(assetIds)];
  if (ids.length === 0) return { added: 0, skipped: 0 };

  return withSession(user, async (tx) => {
    await assertDossierEditable(tx, user, dossierId);

    const [assets, existing, last] = await Promise.all([
      tx.asset.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } }),
      tx.dossierItem.findMany({
        where: { dossierId, assetId: { in: ids } },
        select: { assetId: true },
      }),
      tx.dossierItem.findFirst({
        where: { dossierId },
        orderBy: { sortOrder: "desc" },
        select: { sortOrder: true },
      }),
    ]);
    const titles = new Map(assets.map((a) => [a.id, a.title]));
    const already = new Set(existing.flatMap((i) => (i.assetId ? [i.assetId] : [])));

    // クリアランス外・存在しない・既にあるものを飛ばす
    const toAdd = ids.filter((id) => titles.has(id) && !already.has(id));
    if (toAdd.length === 0) return { added: 0, skipped: ids.length };

    const base = (last?.sortOrder ?? -1) + 1;
    await tx.dossierItem.createMany({
      data: toAdd.map((assetId, i) => ({
        dossierId,
        kind: "asset_ref" as const,
        assetId,
        caption: titles.get(assetId)!,
        sortOrder: base + i,
      })),
    });
    return { added: toAdd.length, skipped: ids.length - toAdd.length };
  });
}
