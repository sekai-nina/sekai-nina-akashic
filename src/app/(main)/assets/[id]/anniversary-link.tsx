import Link from "next/link";
import { CalendarHeart } from "lucide-react";

/**
 * アセットページのヘッダ操作。「これ初〇〇だ」と気づいた場面で、日付と出典が埋まった
 * 登録フォームへ飛ぶ。既にこのアセットから作った記念日があればそちらへのリンクになる
 * (同じアセットから 2 件目を作るときはフォーム側で)
 */
export function AnniversaryLink({
  assetId,
  existing,
}: {
  assetId: string;
  existing: { id: string; date: string; title: string }[];
}) {
  const cls =
    "inline-flex items-center gap-1 border border-slate-300 text-slate-700 px-3 py-1.5 rounded text-sm hover:bg-slate-50 transition-colors";
  if (existing.length > 0) {
    const first = existing[0];
    return (
      <Link href={`/anniversaries/${first.id}`} className={cls} title={existing.map((a) => `${a.date} ${a.title}`).join("\n")}>
        <CalendarHeart className="h-4 w-4 text-green-600" />
        記念日: {first.title}
        {existing.length > 1 && ` +${existing.length - 1}`}
      </Link>
    );
  }
  return (
    <Link href={`/anniversaries/new?assetId=${assetId}`} className={cls}>
      <CalendarHeart className="h-4 w-4" />
      記念日に登録
    </Link>
  );
}
