/**
 * REST (/api/v1/meetgreets) の入力スキーマと返却の射影。
 * 画面 (Server Actions) とは別経路だが domain 関数は同じものを呼ぶ。
 */

import { z } from "zod";
import type { MeetGreetSummary, MeetGreetDetail } from "@/lib/domain/meetgreets";
import type { CandidateGroup } from "./candidates";
import { getR2PublicUrl } from "@/lib/r2";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const CreateMeetGreetSchema = z
  .object({
    date: z.string().regex(DATE_RE, "YYYY-MM-DD で指定してください"),
    format: z.enum(["online", "real"]),
    single: z.string().max(200).optional(),
    label: z.string().max(50).optional(),
    classification: z.enum(["public", "internal", "confidential", "restricted"]).optional(),
  })
  .strict();

export const UpdateMeetGreetSchema = z
  .object({
    single: z.string().max(200).optional(),
    label: z.string().max(50).optional(),
    extraSketchPrompt: z.string().max(4000).optional(),
  })
  .strict();

export const ApplyMaterialsSchema = z
  .object({
    assetIds: z.array(z.string().min(1)).min(1).max(500),
  })
  .strict();

export function projectMeetGreet(mg: MeetGreetSummary | MeetGreetDetail) {
  return {
    id: mg.id,
    date: mg.date,
    format: mg.format,
    single: mg.single,
    label: mg.label,
    classification: mg.classification,
    dossier: {
      id: mg.dossier.id,
      title: mg.dossier.title,
      itemCount: mg.dossier._count.items,
      updatedAt: mg.dossier.updatedAt,
    },
    repoCollection: mg.repoCollection
      ? {
          id: mg.repoCollection.id,
          name: mg.repoCollection.name,
          lastFetchedAt: mg.repoCollection.lastFetchedAt,
          keep: mg.reports?.keep ?? 0,
          total: mg.reports?.total ?? 0,
        }
      : null,
    article: mg.article
      ? {
          id: mg.article.id,
          shortId: mg.article.shortId,
          title: mg.article.title,
          dirty: mg.article.dirty,
          lastPushedAt: mg.article.lastPushedAt,
        }
      : null,
    sketch: {
      key: mg.sketchKey,
      url: mg.sketchKey ? getR2PublicUrl(mg.sketchKey) : null,
      candidates: Array.isArray(mg.sketchCandidates)
        ? (mg.sketchCandidates as string[]).map((k) => ({ key: k, url: getR2PublicUrl(k) }))
        : [],
      extraPrompt: mg.extraSketchPrompt,
    },
    createdBy: mg.createdBy,
    createdAt: mg.createdAt,
    updatedAt: mg.updatedAt,
  };
}

/** 候補はそのまま返す (bot は suggested を初期値にして人に見せる) */
export function projectCandidates(groups: CandidateGroup[]) {
  return groups.map((g) => ({
    key: g.key,
    kind: g.kind,
    title: g.title,
    url: g.url,
    matched: g.matched,
    assets: g.assets,
  }));
}
