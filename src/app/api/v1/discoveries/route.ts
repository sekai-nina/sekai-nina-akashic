import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { listDiscoveries, listFoodRows } from "@/lib/domain/discoveries";
import { getR2PublicUrl } from "@/lib/r2";

/**
 * 今日の発見の全件 (#432)。通し番号 (`no`) 付きで古い順に返す。サイトの「今日の発見ノート」と一覧記事が
 * ビルド時に読む。件数は数百件なのでページングしない。
 * `foods` は材料・できあがる味の名前 → 分類 (チップを分類の見出しごとに並べるのに使う)。分類がまだの名前は入らない。
 * `foodIcons` は名前 → イラストのアイコンの URL (#436)。アイコンがまだの名前は入らない
 */
export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const [items, foodRows] = await Promise.all([listDiscoveries(auth.clearance), listFoodRows()]);
  // 見える発見に出てくる名前だけを返す (見えない発見の材料名を漏らさない)
  const names = new Set(items.flatMap((d) => (d.result ? [...d.ingredients, d.result] : d.ingredients)));
  const visible = foodRows.filter((f) => names.has(f.name));
  const foods = Object.fromEntries(visible.map((f) => [f.name, f.category]));
  const foodIcons = Object.fromEntries(visible.filter((f) => f.iconKey).map((f) => [f.name, getR2PublicUrl(f.iconKey)]));
  return NextResponse.json({ items, total: items.length, foods, foodIcons });
}
