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
  // 関連フィルタ（v2.4: 言及∪本人著）: 1=関連あり / 0=関連なし（url 系のみ有効）。
  // 旧パラメータ名 mentions もエイリアスとして受け付ける。
  const relevantParam =
    url.searchParams.get("relevant") ?? url.searchParams.get("mentions");
  const relevant =
    relevantParam === "1" || relevantParam === "true"
      ? true
      : relevantParam === "0" || relevantParam === "false"
        ? false
        : undefined;
  const order = url.searchParams.get("order") === "desc" ? "desc" : "asc";
  const page = Number(url.searchParams.get("page") ?? "1") || 1;
  const pageSize = Number(url.searchParams.get("pageSize") ?? "100") || 100;

  try {
    const result = await listItems(
      source,
      { lensKey: lensKey ?? undefined, checked, relevant, order, page, pageSize },
      { id: auth.id, clearance: auth.clearance }
    );
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
