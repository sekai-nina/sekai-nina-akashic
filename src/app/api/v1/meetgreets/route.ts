import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { invalidateDossiers } from "@/lib/cache";
import {
  createMeetGreet,
  getMeetGreet,
  listMaterialCandidates,
  listMeetGreets,
} from "@/lib/domain/meetgreets";
import { MeetGreetInputError } from "@/lib/domain/meetgreets";
import { CreateMeetGreetSchema, projectCandidates, projectMeetGreet } from "@/lib/meetgreet/api";
import { formatZodError } from "@/lib/zod-error";

/**
 * X の収集 (画像を 1 枚ずつ R2 に載せる) で 1 分を超えることがある。
 * Discord bot はこの所要時間を見越して deferred ack してから呼ぶこと。
 */
export const maxDuration = 300;

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const rows = await listMeetGreets(auth);
  return NextResponse.json({ items: rows.map(projectMeetGreet) });
}

/**
 * 起点。ドシエと X レポ収集を自動で作り、収集を 1 回走らせ、素材候補まで返す
 * (Discord bot はこれ 1 回で「確認はこちら」を返せる)。
 * X の収集失敗は 201 のまま `fetch.ok = false` で知らせる (再収集は POST /meetgreets/:id/reports)。
 */
export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = CreateMeetGreetSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  let created: Awaited<ReturnType<typeof createMeetGreet>>;
  try {
    created = await createMeetGreet(auth, parsed.data);
  } catch (e) {
    // 想定外 (DB エラー等) は握り潰さず 500 にする。400 に丸めると呼び出し側が
    // 「入力が悪い」と誤解して同じ内容で再試行し、ドシエ・収集が二重にできる
    if (e instanceof MeetGreetInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    if (e instanceof Error && e.message.includes("Access denied")) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    throw e;
  }
  invalidateDossiers();

  const mg = await getMeetGreet(auth, created.id);
  if (!mg) return NextResponse.json({ error: "created but not visible" }, { status: 500 });
  const candidates = await listMaterialCandidates(auth, mg);

  return NextResponse.json(
    {
      ...projectMeetGreet(mg),
      fetch: created.fetch,
      candidates: projectCandidates(candidates),
    },
    { status: 201 }
  );
}
