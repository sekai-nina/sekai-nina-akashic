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

/** 作成自体は速い。X の収集は POST /meetgreets/:id/reports で明示的に行う */
export const maxDuration = 60;

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const rows = await listMeetGreets(auth);
  return NextResponse.json({ items: rows.map(projectMeetGreet) });
}

/**
 * 起点。ドシエと X レポ収集を用意して紐づけ、素材候補まで返す。
 * **X の収集は走らせない** (POST /meetgreets/:id/reports で明示的に行う)。
 * `dossierId` / `repoCollectionId` を渡すと既にあるものを使う。
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
    { ...projectMeetGreet(mg), candidates: projectCandidates(candidates) },
    { status: 201 }
  );
}
