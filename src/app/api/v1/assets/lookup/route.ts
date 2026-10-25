import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { LOOKUP_MAX_KEYS, lookupSourceAssets } from "@/lib/domain/text-revisions";

/**
 * 出典キーからアセットを引く (#262)。bot がブログ・トークの取りこぼしを突き合わせるのに使う。
 * body: { urls?: string[], talkMessageIds?: (string | number)[] }
 */
export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { urls = [], talkMessageIds = [] } = (body ?? {}) as { urls?: unknown; talkMessageIds?: unknown };

  if (!Array.isArray(urls) || !urls.every((u) => typeof u === "string")) {
    return NextResponse.json({ error: "urls must be an array of strings" }, { status: 400 });
  }
  if (
    !Array.isArray(talkMessageIds) ||
    !talkMessageIds.every((m) => typeof m === "string" || (typeof m === "number" && Number.isSafeInteger(m)))
  ) {
    return NextResponse.json({ error: "talkMessageIds must be an array of strings or integers" }, { status: 400 });
  }
  if (urls.length + talkMessageIds.length > LOOKUP_MAX_KEYS) {
    return NextResponse.json(
      { error: `urls と talkMessageIds は合わせて ${LOOKUP_MAX_KEYS} 件までです` },
      { status: 400 }
    );
  }

  const result = await lookupSourceAssets(
    { urls: urls as string[], talkMessageIds: talkMessageIds.map(String) },
    auth.clearance
  );
  return NextResponse.json(result);
}
