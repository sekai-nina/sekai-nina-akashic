/**
 * REST (/api/v1/lives) の入力スキーマと返却の射影。
 * 画面 (Server Actions) とは別経路だが domain 関数は同じものを呼ぶ。
 */

import { z } from "zod";
import { isValidDateString } from "@/lib/utils";
import { getR2PublicUrl } from "@/lib/r2";
import type { LiveDetail, LiveSummary } from "@/lib/domain/lives";
import { jsonStringArray, MAX_EXTRA_SKETCH_PROMPT } from "@/lib/meetgreet/config";
import {
  MAX_LIVE_NAME,
  MAX_LIVE_NOTE,
  MAX_PERFORMANCE_LABEL,
  MAX_PERFORMANCE_NOTE,
  MAX_PERFORMANCES,
  MAX_REPORT_TAG_LENGTH,
  MAX_REPORT_TAGS,
  MAX_SONG_TITLE,
  MAX_SONGS_PER_LIST,
  MAX_VENUE,
} from "./config";

const SongList = z.array(z.string().max(MAX_SONG_TITLE)).max(MAX_SONGS_PER_LIST);

const PerformanceSchema = z
  .object({
    /** 既存の公演を残して更新する (PUT /setlist のみ。作成では受け付けない) */
    id: z.string().min(1).optional(),
    date: z.string().refine(isValidDateString, "暦に実在する YYYY-MM-DD で指定してください"),
    venue: z.string().max(MAX_VENUE).optional(),
    label: z.string().max(MAX_PERFORMANCE_LABEL).optional(),
    note: z.string().max(MAX_PERFORMANCE_NOTE).optional(),
    songs: SongList.optional(),
    centerSongs: SongList.optional(),
  })
  .strict();

export const SetlistSchema = z
  .object({
    performances: z.array(PerformanceSchema).min(1).max(MAX_PERFORMANCES),
    commonSongs: SongList.optional(),
  })
  .strict();

/** 作成では公演の `id` を受け付けない (DB が振る。混ざると他のライブの公演に曲が紐づく) */
export const CreateLiveSchema = z.object({
  performances: z.array(PerformanceSchema.omit({ id: true })).min(1).max(MAX_PERFORMANCES),
  commonSongs: SongList.optional(),
  name: z.string().trim().min(1, "ライブ名を入れてください").max(MAX_LIVE_NAME),
  note: z.string().max(MAX_LIVE_NOTE).optional(),
  classification: z.enum(["public", "internal", "confidential", "restricted"]).optional(),
  /** 既にある event エンティティを使う (未指定ならライブ名で find-or-create) */
  entityId: z.string().min(1).optional(),
  /** 既にあるドシエ / X レポ収集を使う (未指定なら新しく作る) */
  dossierId: z.string().min(1).optional(),
  repoCollectionId: z.string().min(1).optional(),
}).strict();


export const UpdateLiveSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_LIVE_NAME).optional(),
    note: z.string().max(MAX_LIVE_NOTE).optional(),
    /** X レポ収集のハッシュタグ (#150)。`#` は付けても付けなくてもよい */
    reportTags: z.array(z.string().max(MAX_REPORT_TAG_LENGTH)).max(MAX_REPORT_TAGS).optional(),
    extraSketchPrompt: z.string().max(MAX_EXTRA_SKETCH_PROMPT).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "更新項目がありません",
  });

export function projectLive(live: LiveSummary | LiveDetail) {
  return {
    id: live.id,
    name: live.name,
    note: live.note,
    classification: live.classification,
    entity: live.entity ? { id: live.entity.id, name: live.entity.canonicalName } : null,
    firstDate: live.firstDate,
    lastDate: live.lastDate,
    commonSongs: live.commonSongs,
    performances: live.performances.map((p) => ({
      id: p.id,
      date: p.date,
      venue: p.venue,
      label: p.label,
      note: p.note,
      songs: p.songs,
      centerSongs: p.centerSongs,
    })),
    // ドシエが所有者に private へ戻された / 機密を上げられたときは null (RLS で見えない)
    dossier: live.dossier
      ? {
          id: live.dossier.id,
          title: live.dossier.title,
          itemCount: live.dossier.itemCount,
          updatedAt: live.dossier.updatedAt,
        }
      : null,
    dossierId: live.dossierId,
    /** X レポ収集のハッシュタグ (坂井新奈 AND 各タグ、タグ間 OR) */
    reportTags: jsonStringArray(live.reportTags),
    repoCollection: live.repoCollection
      ? {
          id: live.repoCollection.id,
          name: live.repoCollection.name,
          lastFetchedAt: live.repoCollection.lastFetchedAt,
          keep: live.reports?.keep ?? 0,
          total: live.reports?.total ?? 0,
        }
      : null,
    article: live.article
      ? {
          id: live.article.id,
          shortId: live.article.shortId,
          title: live.article.title,
          dirty: live.article.dirty,
          lastPushedAt: live.article.lastPushedAt,
        }
      : null,
    sketch: {
      key: live.sketchKey,
      url: live.sketchKey ? getR2PublicUrl(live.sketchKey) : null,
      // Json 列なので中身は信用しない (文字列以外が混ざっていても URL を組み立てない)
      candidates: (Array.isArray(live.sketchCandidates) ? live.sketchCandidates : [])
        .filter((k): k is string => typeof k === "string")
        .map((k) => ({ key: k, url: getR2PublicUrl(k) })),
      extraPrompt: live.extraSketchPrompt,
    },
    createdBy: live.createdBy,
    createdAt: live.createdAt,
    updatedAt: live.updatedAt,
  };
}
