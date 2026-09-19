/**
 * REST (/api/v1/meetgreets) の入力スキーマと返却の射影。
 * 画面 (Server Actions) とは別経路だが domain 関数は同じものを呼ぶ。
 */

import { z } from "zod";
import { isValidDateString } from "@/lib/utils";
import { MAX_EXCERPTS_PER_APPLY, MAX_REFERENCE_PHOTOS, maxReferencePhotos } from "./config";
import type { MeetGreetSummary, MeetGreetDetail } from "@/lib/domain/meetgreets";
import type { CandidateGroup } from "./candidates";
import { getR2PublicUrl } from "@/lib/r2";

/** 作り直しの指示の長さ */
export const MAX_REVISION_NOTE = 2000;

/** 回ごとの追加指示の長さ */
export const MAX_EXTRA_SKETCH_PROMPT = 4000;

export const CreateMeetGreetSchema = z
  .object({
    date: z
      .string()
      .refine(isValidDateString, "暦に実在する YYYY-MM-DD で指定してください"),
    format: z.enum(["online", "real"]),
    single: z.string().max(200).optional(),
    label: z.string().max(50).optional(),
    classification: z.enum(["public", "internal", "confidential", "restricted"]).optional(),
    /** 既にあるドシエ / X レポ収集を使う (未指定なら新しく作る) */
    dossierId: z.string().min(1).optional(),
    repoCollectionId: z.string().min(1).optional(),
  })
  .strict();

export const UpdateMeetGreetSchema = z
  .object({
    single: z.string().max(200).optional(),
    label: z.string().max(50).optional(),
    extraSketchPrompt: z.string().max(MAX_EXTRA_SKETCH_PROMPT).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "更新項目がありません",
  });

/** 1 回の反映で受け付けるアセット数の上限 (画面・REST 共通) */
export const MAX_MATERIALS_PER_APPLY = 500;


export const ApplyMaterialsSchema = z
  .object({
    assetIds: z.array(z.string().min(1)).min(1).max(MAX_MATERIALS_PER_APPLY),
  })
  .strict();

export const ApplyExcerptsSchema = z
  .object({
    inputs: z
      .array(
        z
          .object({
            assetId: z.string().min(1),
            start: z.number().int().min(0),
            end: z.number().int().min(1),
          })
          .strict()
          .refine((v) => v.end > v.start, { message: "end は start より後にしてください" })
      )
      .min(1)
      .max(MAX_EXCERPTS_PER_APPLY),
  })
  .strict();

export const GenerateSketchSchema = z
  .object({
    assetIds: z.array(z.string().min(1)).min(1).max(MAX_REFERENCE_PHOTOS),
    /** 作り直しの元にする候補の R2 key (sketch.candidates[].key) */
    revisionOf: z.string().min(1).optional(),
    revisionNote: z.string().max(MAX_REVISION_NOTE).optional(),
  })
  .strict()
  .refine((v) => !v.revisionNote || v.revisionOf, {
    message: "revisionNote は revisionOf と一緒に指定してください",
  })
  // 作り直しでは直す候補で 1 枚使うので、写真の上限が 1 枚下がる (合計 16 枚)
  .refine((v) => v.assetIds.length <= maxReferencePhotos(!!v.revisionOf), {
    message: `作り直しのときの参照写真は ${maxReferencePhotos(true)} 枚までです`,
  });

export const SelectSketchSchema = z.object({ key: z.string().min(1) }).strict();

export function projectMeetGreet(mg: MeetGreetSummary | MeetGreetDetail) {
  return {
    id: mg.id,
    date: mg.date,
    format: mg.format,
    single: mg.single,
    label: mg.label,
    classification: mg.classification,
    // ドシエが所有者に private へ戻された / 機密を上げられたときは null (RLS で見えない)
    dossier: mg.dossier
      ? {
          id: mg.dossier.id,
          title: mg.dossier.title,
          itemCount: mg.dossier.itemCount,
          updatedAt: mg.dossier.updatedAt,
        }
      : null,
    dossierId: mg.dossierId,
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
      // Json 列なので中身は信用しない (文字列以外が混ざっていても URL を組み立てない)
      candidates: (Array.isArray(mg.sketchCandidates) ? mg.sketchCandidates : [])
        .filter((k): k is string => typeof k === "string")
        .map((k) => ({ key: k, url: getR2PublicUrl(k) })),
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
