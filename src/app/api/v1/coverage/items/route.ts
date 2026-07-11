import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { listItems } from "@/lib/domain/coverage";

/**
 * GET /coverage/items?source=blog&lens=food&checked=0&order=asc&page=1&pageSize=100
 * ソースのアイテム一覧。lens 省略時は全観点の checkedLensKeys 付き。
 */
export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const source = url.searchParams.get("source");
  if (!source) {
    return NextResponse.json({ error: "source is required" }, { status: 400 });
  }

  const lensKey = url.searchParams.get("lens");
  const checkedParam = url.searchParams.get("checked");
  const checked =
    checkedParam === "1" || checkedParam === "true"
      ? true
      : checkedParam === "0" || checkedParam === "false"
        ? false
        : undefined;
  const order = url.searchParams.get("order") === "desc" ? "desc" : "asc";
  const page = Number(url.searchParams.get("page") ?? "1") || 1;
  const pageSize = Number(url.searchParams.get("pageSize") ?? "100") || 100;

  try {
    const result = await listItems(
      source,
      { lensKey: lensKey ?? undefined, checked, order, page, pageSize },
      auth.clearance
    );
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
