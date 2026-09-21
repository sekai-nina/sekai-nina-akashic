/**
 * 「本人の感想」の抜粋提案と反映 (#108。#150 でライブと共用)。
 *
 * ドシエに入っている本人ブログの本文を LLM に読ませ、そのミーグリ / ライブについて書いている
 * 範囲を候補として出す。人が選んだものだけを `DossierItem` の抜粋として入れる。
 *
 * **公開サイトの引用になる文面なので、提案をそのまま採用はしない。**
 */

import { withSession } from "@/lib/db";
import { classificationFilter } from "@/lib/classification";
import { proposeExcerpts, type ExcerptTopicKind } from "@/lib/meetgreet/excerpt";
import {
  MAX_BLOGS_PER_PROPOSAL,
  MAX_EXCERPTS_PER_APPLY,
  MAX_EXTERNAL_AI_CLEARANCE,
} from "@/lib/meetgreet/config";
import type { ApplyExcerptInput, BlogExcerptProposals } from "@/lib/meetgreet/types";
import { addAssetItem } from "./dossiers";
import { logAudit } from "./audit";
import { WorkflowInputError, type ActingUser } from "./article-workflow";

/** 抜粋を入れる器 (ミーグリ / ライブ)。LLM に伝える対象と、監査ログの宛先 */
export interface ExcerptTarget {
  kind: ExcerptTopicKind;
  id: string;
  dossierId: string;
  /** LLM に伝える対象 (「2026-08-01 のリアルミート＆グリート」等) */
  subject: string;
  /** 器ごとの入力エラー (REST が instanceof で 400 にする)。無ければ WorkflowInputError */
  inputError?: new (message: string) => WorkflowInputError;
}

/** 監査ログの targetType */
const TARGET_TYPE: Record<ExcerptTopicKind, string> = { meetgreet: "MeetGreet", live: "Live" };

/** ブログ本文を指す URL か (ひなたぼっこ日記 = 運営ブログは本人の感想ではないので対象外) */
const OWN_BLOG_URL_FRAGMENT = "/diary/detail/";

/**
 * ドシエに入っている本人ブログの本文から抜粋案を出す。
 *
 * **この時点では DB に書かない。** 人が選んでから `applyExcerpts` で入れる。
 *
 * 本文は外部 (OpenAI) に送るので、`MAX_EXTERNAL_AI_CLEARANCE` を超える機密のアセットは
 * そもそも読まない。ブログの本数にも上限を置く (LLM 呼び出しが際限なく増えないように)。
 */
export async function proposeExcerptsForDossier(
  user: ActingUser,
  target: Pick<ExcerptTarget, "kind" | "dossierId" | "subject">
): Promise<BlogExcerptProposals[]> {
  const items = await withSession(user, (tx) =>
    tx.dossierItem.findMany({
      where: {
        dossierId: target.dossierId,
        asset: {
          kind: "text",
          // 外部 AI に渡してよい機密レベルまで
          ...classificationFilter(MAX_EXTERNAL_AI_CLEARANCE),
          // 出典のどれかが本人ブログであればよい (先頭の 1 件だけを見ると取りこぼす)
          sourceRecords: { some: { url: { contains: OWN_BLOG_URL_FRAGMENT } } },
        },
      },
      select: {
        excerptStart: true,
        excerptEnd: true,
        asset: {
          select: {
            id: true,
            title: true,
            sourceRecords: {
              where: { url: { contains: OWN_BLOG_URL_FRAGMENT } },
              select: { url: true },
              take: 1,
            },
            texts: {
              where: { textType: "body" },
              select: { content: true },
              // createdAt だけだと同時作成の 2 行で順序が決まらない
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              take: 1,
            },
          },
        },
      },
    })
  );

  // 同じアセットが抜粋ごとに複数 item を持つので、アセット単位にまとめる
  const byAsset = new Map<
    string,
    { title: string; url: string | null; content: string; taken: { start: number; end: number }[] }
  >();
  for (const item of items) {
    const a = item.asset;
    if (!a) continue;
    const content = a.texts[0]?.content;
    if (!content) continue;
    const entry = byAsset.get(a.id) ?? {
      title: a.title,
      url: a.sourceRecords[0]?.url ?? null,
      content,
      taken: [],
    };
    if (item.excerptStart != null && item.excerptEnd != null) {
      entry.taken.push({ start: item.excerptStart, end: item.excerptEnd });
    }
    byAsset.set(a.id, entry);
  }

  const targets = [...byAsset.entries()].slice(0, MAX_BLOGS_PER_PROPOSAL);

  // ブログごとに独立なので並列で投げる (直列だと本数ぶん待つ)
  return Promise.all(
    targets.map(async ([assetId, entry]) => {
      const proposals = await proposeExcerpts(entry.content, {
        subject: target.subject,
        blogTitle: entry.title,
        kind: target.kind,
      });
      return {
        assetId,
        title: entry.title,
        url: entry.url,
        // 既にドシエに入っている範囲と重なるものは出さない
        proposals: proposals.filter(
          (p) => !entry.taken.some((t) => p.start < t.end && t.start < p.end)
        ),
      };
    })
  );
}

/**
 * 選んだ抜粋をドシエに入れる。抜粋付きの item は 1 抜粋 = 1 item
 * (`addAssetItem` は excerpt があるとき必ず新しい item を作る)。
 *
 * 本文は DB から切り出す (画面から渡された文字列を信じない)。**対象は
 * このドシエに入っているアセットに限る** — 限定しないと、読めるアセットの本文を
 * 何でもこのドシエ (通常 internal) に写せてしまい、上位機密の文章が下位に降りる。
 */
export async function applyExcerpts(
  user: ActingUser,
  target: Pick<ExcerptTarget, "kind" | "id" | "dossierId" | "inputError">,
  inputs: ApplyExcerptInput[]
): Promise<{ added: number; skipped: number }> {
  if (inputs.length === 0) return { added: 0, skipped: 0 };
  if (inputs.length > MAX_EXCERPTS_PER_APPLY) {
    const Err = target.inputError ?? WorkflowInputError;
    throw new Err(`一度に反映できる抜粋は ${MAX_EXCERPTS_PER_APPLY} 件までです`);
  }

  const assetIds = [...new Set(inputs.map((i) => i.assetId))];
  const [texts, existing] = await withSession(user, (tx) =>
    Promise.all([
      tx.assetText.findMany({
        where: {
          assetId: { in: assetIds },
          textType: "body",
          // このドシエに入っているアセットだけ
          asset: { dossierItems: { some: { dossierId: target.dossierId } } },
        },
        select: { assetId: true, content: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      tx.dossierItem.findMany({
        where: {
          dossierId: target.dossierId,
          assetId: { in: assetIds },
          excerptStart: { not: null },
          excerptEnd: { not: null },
        },
        select: { assetId: true, excerptStart: true, excerptEnd: true },
      }),
    ])
  );

  const contentByAsset = new Map<string, string>();
  for (const t of texts) if (!contentByAsset.has(t.assetId)) contentByAsset.set(t.assetId, t.content);

  // 既存の範囲。**この呼び出しで足したぶんも足していく**
  // (同じリクエスト内で重なり合う 2 つが両方入るのを防ぐ)
  const taken = existing.flatMap((e) =>
    e.assetId && e.excerptStart != null && e.excerptEnd != null
      ? [{ assetId: e.assetId, start: e.excerptStart, end: e.excerptEnd }]
      : []
  );

  let added = 0;
  let skipped = 0;
  for (const input of inputs) {
    const content = contentByAsset.get(input.assetId);
    const valid =
      content !== undefined &&
      Number.isInteger(input.start) &&
      Number.isInteger(input.end) &&
      input.start >= 0 &&
      input.end > input.start &&
      input.end <= content.length;
    const overlaps = taken.some(
      (t) => t.assetId === input.assetId && input.start < t.end && t.start < input.end
    );
    if (!valid || overlaps) {
      skipped++;
      continue;
    }
    await addAssetItem(user, target.dossierId, {
      assetId: input.assetId,
      excerpt: content.slice(input.start, input.end),
      excerptType: "body",
      excerptStart: input.start,
      excerptEnd: input.end,
    });
    taken.push({ assetId: input.assetId, start: input.start, end: input.end });
    added++;
  }

  await logAudit({
    actorId: user.id,
    action: `${target.kind}.excerpts.apply`,
    targetType: TARGET_TYPE[target.kind],
    targetId: target.id,
    metadata: { added, skipped, dossierId: target.dossierId },
  });
  return { added, skipped };
}
