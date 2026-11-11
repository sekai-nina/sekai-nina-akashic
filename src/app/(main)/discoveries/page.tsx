import Link from "next/link";
import { notFound } from "next/navigation";
import { Lightbulb } from "lucide-react";
import { auth } from "@/lib/auth";
import { AUTO_DRAFT_MAX_ATTEMPTS, listDiscoveries } from "@/lib/domain/discoveries";
import { getReviewBlog, listFoods, listGivenUpBlogs, newestFirst, reviewQueue } from "@/lib/domain/discovery-review";
import { DISCOVERY_CONFIDENCE_LABELS } from "@/lib/utils";
import { DiscoveryEditor } from "./discovery-editor";
import { FoodsTable } from "./foods-table";
import { RetryButton } from "./retry-button";

type Tab = "review" | "foods" | "all";

const TABS: [Tab, string][] = [
  ["review", "確認待ち"],
  ["foods", "材料と分類"],
  ["all", "すべて"],
];

/**
 * 今日の発見の確認 (#432)。Claude が下書きした発見 (材料・できあがる味・確信度) を人が確かめて直す。
 * - 確認待ち: 人が確かめていない発見のあるブログを 1 本ずつ。直して確定すると次へ
 * - 材料と分類: 名前の一覧。分類の変更と、名前の変更 (全部の発見で書き換え)
 * - すべて: 確定済みも含めた一覧から開いて直す (`?asset=`)
 * 直した値は、サイトの「今日の発見ノート」と一覧記事の次のビルドに出る
 */
export default async function DiscoveriesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await auth();
  if (!session?.user) notFound();
  const canEdit = ["admin", "member"].includes(session.user.role);
  const clearance = session.user.clearance;
  const params = await searchParams;
  const tab: Tab = params.tab === "foods" || params.tab === "all" ? params.tab : "review";

  // あきらめたブログは確認待ちタブだけで使うが、一覧と独立なので並べて読む
  const [all, givenUp] = await Promise.all([
    listDiscoveries(clearance),
    tab === "review" ? listGivenUpBlogs(clearance) : Promise.resolve([]),
  ]);
  const queue = reviewQueue(all);
  const reviewedCount = all.filter((d) => d.reviewed).length;

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <Lightbulb className="h-6 w-6 text-amber-500" />
          今日の発見
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Claude が下書きした材料・できあがる味・確信度を確かめて直します。直した値はサイトの「今日の発見ノート」の次のビルドに出ます。
          確定した発見は、自動の下書きがもう上書きしません。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-sm">
          {TABS.map(([t, label]) => (
            <Link
              key={t}
              href={`/discoveries?tab=${t}`}
              className={`px-3 py-1.5 rounded-md ${tab === t ? "bg-amber-500 text-white" : "text-slate-600 hover:bg-slate-50"}`}
            >
              {label}
              {t === "review" && queue.length > 0 && <span className="ml-1 tabular-nums">{queue.length}</span>}
            </Link>
          ))}
        </div>
        <span className="text-sm text-slate-500 tabular-nums">
          発見 {all.length} 件 / 確定済み {reviewedCount} 件
        </span>
      </div>

      {tab === "review" && (
        <ReviewTab clearance={clearance} all={all} givenUp={givenUp} queue={queue} assetParam={params.asset} canEdit={canEdit} />
      )}
      {tab === "foods" && <FoodsTab all={all} canEdit={canEdit} />}
      {tab === "all" && <AllTab rows={newestFirst(all)} />}
    </div>
  );
}

type Discoveries = Awaited<ReturnType<typeof listDiscoveries>>;

async function ReviewTab({
  clearance,
  all,
  givenUp,
  queue,
  assetParam,
  canEdit,
}: {
  clearance: string;
  all: Discoveries;
  givenUp: Awaited<ReturnType<typeof listGivenUpBlogs>>;
  queue: string[];
  assetParam: string | undefined;
  canEdit: boolean;
}) {
  // ?asset= があればそのブログ (すべてタブから開いたとき)。無ければ確認待ちの先頭
  const assetId = assetParam ?? queue[0];
  const blog = assetId ? await getReviewBlog(clearance, assetId, all) : null;
  return (
    <div className="space-y-4">
      {givenUp.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="font-medium text-amber-900">自動の下書きが {AUTO_DRAFT_MAX_ATTEMPTS} 回失敗してあきらめたブログ</p>
          <ul className="mt-2 space-y-1">
            {givenUp.map((g) => (
              <li key={g.assetId} className="flex flex-wrap items-center gap-2">
                <a href={`/assets/${g.assetId}`} className="text-sky-700 hover:underline">{g.title}</a>
                <span className="text-xs text-amber-800">{g.lastError ?? ""}</span>
                {canEdit && <RetryButton assetId={g.assetId} />}
              </li>
            ))}
          </ul>
        </div>
      )}
      {assetParam && (
        <p className="text-sm">
          <Link href="/discoveries?tab=all" className="text-sky-700 hover:underline">← すべてに戻る</Link>
        </p>
      )}
      {blog ? (
        <>
          {!assetParam && <p className="text-sm text-slate-500">確認待ちのブログ あと {queue.length} 本</p>}
          <DiscoveryEditor key={blog.assetId} blog={blog} mode={assetParam ? "edit" : "review"} canEdit={canEdit} />
        </>
      ) : (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-slate-500">
          {assetParam ? "このブログは見つかりませんでした。" : "確認待ちの発見はありません。"}
        </div>
      )}
    </div>
  );
}

async function FoodsTab({ all, canEdit }: { all: Discoveries; canEdit: boolean }) {
  const rows = await listFoods(all);
  return <FoodsTable rows={rows} canEdit={canEdit} />;
}

function AllTab({ rows }: { rows: Discoveries }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs text-slate-500">
          <tr>
            <th className="text-right px-3 py-2 font-medium">No.</th>
            <th className="text-left px-3 py-2 font-medium">日付</th>
            <th className="text-left px-3 py-2 font-medium">見出し</th>
            <th className="text-left px-3 py-2 font-medium">組み合わせ</th>
            <th className="text-left px-3 py-2 font-medium">確信度</th>
            <th className="text-left px-3 py-2 font-medium">状態</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} className="border-t border-slate-100 align-top">
              <td className="px-3 py-2 text-right tabular-nums text-slate-500">{d.no}</td>
              <td className="px-3 py-2 tabular-nums text-slate-500 whitespace-nowrap">{d.date}</td>
              <td className="px-3 py-2">
                <Link href={`/discoveries?tab=review&asset=${d.assetId}`} className="text-slate-900 hover:underline">
                  {d.heading}
                </Link>
              </td>
              <td className="px-3 py-2 text-slate-600">
                {d.isFood ? `${d.ingredients.join(" ＋ ")}${d.result ? ` → ${d.result}` : ""}` : "(食べ物以外)"}
              </td>
              <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{DISCOVERY_CONFIDENCE_LABELS[d.confidence]}</td>
              <td className="px-3 py-2 whitespace-nowrap">
                {d.reviewed ? (
                  <span className="text-xs text-emerald-700">確定済み</span>
                ) : (
                  <span className="text-xs text-amber-700">下書き</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
