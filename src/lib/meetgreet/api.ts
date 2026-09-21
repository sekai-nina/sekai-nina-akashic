/**
 * REST (/api/v1/meetgreets) の入力スキーマと返却の射影。
 * 画面 (Server Actions) とは別経路だが domain 関数は同じものを呼ぶ。
 */

/**
 * **射影の置き場について (#112)。**
 *
 * 記事は `src/lib/domain/article-api.ts` に置いてある (REST と MCP が同じ形を使うため)。
 * ミーグリは MCP ツールを持たないので、REST だけが使うものとしてここに置いたままにする。
 * MCP ツールを足すときに `domain/` へ移す。
 */
import { z } from "zod";
import { isValidDateString } from "@/lib/utils";
import {
  MAX_EXCERPTS_PER_APPLY,
  MAX_EXTRA_SKETCH_PROMPT,
  MAX_REFERENCE_PHOTOS,
  MAX_SKETCH_SOURCES,
  maxReferencePhotos,
} from "./config";
import type { MeetGreetSummary, MeetGreetDetail } from "@/lib/domain/meetgreets";
import type { CandidateGroup } from "./candidates";
import { MIN_FRACTION } from "./crop";
import { getR2PublicUrl } from "@/lib/r2";

/** 作り直しの指示の長さ */
export const MAX_REVISION_NOTE = 2000;

export { MAX_EXTRA_SKETCH_PROMPT };

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
    /** 会場の正式名称。リアルの記事タイトルに出る (空文字で消せる) */
    venue: z.string().max(100).optional(),
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
    assetIds: z.array(z.string().min(1)).max(MAX_REFERENCE_PHOTOS).default([]),
    /** その回だけの参考画像の key (#159)。ドシエには入っていない */
    refKeys: z.array(z.string().min(1)).max(MAX_REFERENCE_PHOTOS).optional(),
    /** 作り直しの元にする候補の R2 key (sketch.candidates[].key) */
    revisionOf: z.string().min(1).optional(),
    revisionNote: z.string().max(MAX_REVISION_NOTE).optional(),
  })
  .strict()
  .refine((v) => v.assetIds.length + (v.refKeys?.length ?? 0) >= 1, {
    message: "参照にする写真を選んでください",
  })
  .refine((v) => !v.revisionNote || v.revisionOf, {
    message: "revisionNote は revisionOf と一緒に指定してください",
  })
  // 作り直しでは直す候補で 1 枚使うので、写真の上限が 1 枚下がる (合計 16 枚)
  .refine(
    (v) => v.assetIds.length + (v.refKeys?.length ?? 0) <= maxReferencePhotos(!!v.revisionOf),
    {
      message: `作り直しのときの参照写真は ${maxReferencePhotos(true)} 枚までです`,
    }
  );

/**
 * 除外キーの配列 (#134)。**Server Action も公開された口**なので同じものを通す
 * (青天井だと `MeetGreet.articleExclusions` の Json 列が無制限に太る)
 */
export const ExclusionKeysSchema = z.array(z.string().min(1).max(200)).max(200);

/**
 * 参照写真の切り抜き枠 (#136)。`{ "<assetId>": {x,y,w,h} | null }`。
 * 値は**画像に対する割合 (0〜1)**。null は枠を外す = 画像全体を使う
 */
export const SketchCropsSchema = z
  .record(
    // assetId (cuid) のほか、参考画像の R2 key も入る (#159)。
    // `meetgreet/<cuid>/refs/<uuid>.webp` で 60 文字強になるので余裕を持たせる
    z.string().min(1).max(200),
    z
      .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        w: z.number().min(MIN_FRACTION).max(1),
        h: z.number().min(MIN_FRACTION).max(1),
      })
      .strict()
      // 画像の外にはみ出す枠は受け取らない (丸めのぶんだけ許す)
      .refine((c) => c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001, {
        message: "切り抜きの範囲が画像の外にはみ出しています",
      })
      .nullable()
  )
  .refine((m) => Object.keys(m).length <= MAX_SKETCH_SOURCES, {
    message: `一度に指定できるのは ${MAX_SKETCH_SOURCES} 枚までです`,
  });

export const ArticleGenerateSchema = z
  .object({
    /** true なら書き込まず、適用後の本文と増える行だけ返す */
    dryRun: z.boolean().optional(),
    /** dryRun で受け取った digest。渡すと、組み立て直した結果が変わっていたら 409 */
    expectedDigest: z.string().min(1).optional(),
    /** 「今後この回では足さない」と決めたもののキー (dryRun の additions[].key) */
    exclude: ExclusionKeysSchema.optional(),
    /** 「足さない」を取り消すキー (dryRun の excluded[].key)。単独で送る */
    restore: ExclusionKeysSchema.optional(),
  })
  .strict()
  // 取り消しは記事を触らない別の操作。同じ要求に混ぜると、先に取り消したぶん本文が変わって
  // expectedDigest が必ず食い違う (= 何が起きたか分からない 409 になる)。
  // **空配列も「混ぜた」と見なす** (`restore: []` が保存に化けるのを防ぐ)
  .refine((v) => !(v.restore && (v.dryRun || v.exclude?.length || v.expectedDigest)), {
    message: "restore は単独で指定してください",
  });

export const SelectSketchSchema = z.object({ key: z.string().min(1) }).strict();

export function projectMeetGreet(mg: MeetGreetSummary | MeetGreetDetail) {
  return {
    id: mg.id,
    date: mg.date,
    format: mg.format,
    single: mg.single,
    label: mg.label,
    venue: mg.venue,
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
