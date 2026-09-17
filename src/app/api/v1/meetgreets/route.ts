import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { invalidateDossiers } from "@/lib/cache";
import {
  createMeetGreet,
  getMeetGreet,
  listMaterialCandidates,
  listMeetGreets,
} from "@/lib/domain/meetgreets";
import { CreateMeetGreetSchema, projectCandidates, projectMeetGreet } from "@/lib/meetgreet/api";
import { formatZodError } from "@/lib/zod-error";

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
    const message = e instanceof Error ? e.message : String(e);
    const status = message.startsWith("Access denied") ? 403 : 400;
    return NextResponse.json({ error: message }, { status });
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
