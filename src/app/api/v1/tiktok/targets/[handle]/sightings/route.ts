import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiAuth } from "@/lib/api-auth";
import { recordTiktokSightings } from "@/lib/domain/tiktok";
import { handleTiktokError, readJsonBody } from "@/lib/tiktok/api";
import { CAPTION_MAX, MAX_SIGHTINGS_PER_REQUEST, VIDEO_ID_PATTERN } from "@/lib/tiktok/targets";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ handle: string }> };

/**
 * bot が profile で見えた動画を報告し、DL すべき一覧を受け取る (#179)。
 * 台帳の更新は `recordTiktokSightings` に集約 (初回接触の扱いもそこ)。
 */
export const dynamic = "force-dynamic";

const Sighting = z
  .object({
    videoId: z.string().regex(VIDEO_ID_PATTERN),
    // タイムゾーン必須 (`Z` か `+09:00`)。素の日時は受けない
    createTime: z.iso.datetime({ offset: true }),
    // 長すぎても 400 で 1 周を潰さず、切って受ける
    caption: z
      .string()
      .default("")
      .transform((s) => (s.length > CAPTION_MAX ? s.slice(0, CAPTION_MAX) : s)),
    durationSec: z.number().int().min(0).max(36_000).nullable().optional(),
    coverUrl: z.string().url().max(2000).nullable().optional(),
  })
  .strict();

const Body = z
  .object({
    videos: z.array(Sighting).max(MAX_SIGHTINGS_PER_REQUEST),
    secUid: z.string().max(200).nullable().optional(),
    videoCount: z.number().int().min(0).nullable().optional(),
    backfill: z.boolean().optional(),
  })
  .strict();

export async function POST(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { handle } = await params;
  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const parsed = Body.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  try {
    const result = await recordTiktokSightings(
      handle,
      {
        videos: parsed.data.videos.map((v) => ({
          videoId: v.videoId,
          createTime: new Date(v.createTime),
          caption: v.caption,
          durationSec: v.durationSec ?? null,
          coverUrl: v.coverUrl ?? null,
        })),
        secUid: parsed.data.secUid ?? null,
        videoCount: parsed.data.videoCount ?? null,
        backfill: parsed.data.backfill,
      },
      auth.clearance,
    );
    return NextResponse.json({
      initial: result.initial,
      added: result.added,
      counts: result.counts,
      pending: result.pending.map((p) => ({
        videoId: p.videoId,
        url: p.url,
        createTime: p.createTime.toISOString(),
        caption: p.caption,
        notify: p.notify,
      })),
    });
  } catch (e) {
    return handleTiktokError(e);
  }
}
