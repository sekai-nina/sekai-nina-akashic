import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateApiKey, requireApiAuth } from "@/lib/api-auth";
import { getInstaAccount, reportInstaSession } from "@/lib/domain/insta-account";
import { formatZodError } from "@/lib/zod-error";

/**
 * insta-watch が使うアカウント。
 *
 * **パスワードは扱わない。** GET はどの垢を使うかを返すだけ、POST は bot が
 * セッションの生死を報告するためのもの（ssh しなくても `/admin/insta` で分かる）。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await authenticateApiKey(request);
  if (!user) {
    return NextResponse.json({ error: "Invalid or missing API key" }, { status: 401 });
  }
  const account = await getInstaAccount(user.clearance);
  return NextResponse.json(
    { username: account.username, configured: account.configured, sessionValid: account.sessionValid },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const SessionReport = z
  .object({
    valid: z.boolean(),
    error: z.string().max(300).optional(),
    loggedInAt: z.string().datetime().optional(),
  })
  .strict();

export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = SessionReport.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  await reportInstaSession(
    {
      valid: parsed.data.valid,
      error: parsed.data.error,
      loggedInAt: parsed.data.loggedInAt ? new Date(parsed.data.loggedInAt) : undefined,
    },
    auth.clearance,
  );
  return NextResponse.json({ ok: true });
}
