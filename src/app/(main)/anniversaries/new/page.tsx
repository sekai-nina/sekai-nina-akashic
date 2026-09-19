import { auth } from "@/lib/auth";
import { withClearance } from "@/lib/db";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, CalendarHeart } from "lucide-react";
import { listArticlesForAnniversaryPicker } from "@/lib/domain/anniversaries";
import { isValidDateString, toJstDateOnly } from "@/lib/utils";
import { AnniversaryForm, type AnniversaryFormAsset } from "../anniversary-form";
import { createAnniversaryAction } from "../actions";

/**
 * 登録。アセットページの「記念日に登録」からは ?assetId= で来て、日付 (canonicalDate の JST)
 * と出典アセットが埋まった状態で開く。?date= / ?title= で直接指定もできる
 */
export default async function NewAnniversaryPage({
  searchParams,
}: {
  searchParams: Promise<{ assetId?: string; date?: string; title?: string }>;
}) {
  const session = await auth();
  if (!session?.user) notFound();
  if (!["admin", "member"].includes(session.user.role)) notFound();

  const sp = await searchParams;
  let asset: AnniversaryFormAsset | null = null;
  if (sp.assetId) {
    const a = await withClearance(session.user.clearance, (tx) =>
      tx.asset.findUnique({ where: { id: sp.assetId }, select: { id: true, title: true, canonicalDate: true } })
    );
    if (a) asset = { id: a.id, title: a.title, date: toJstDateOnly(a.canonicalDate) };
  }

  const articles = await listArticlesForAnniversaryPicker();
  const date = sp.date && isValidDateString(sp.date) ? sp.date : (asset?.date ?? "");

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <Link
          href="/anniversaries"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-3"
        >
          <ArrowLeft className="h-4 w-4" />
          記念日一覧に戻る
        </Link>
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <CalendarHeart className="h-6 w-6 text-green-600" />
          記念日を登録
        </h1>
        <p className="text-slate-500 text-sm mt-1">坂井新奈が初めて〇〇した日。呼び名は「〇〇の日」の形にすると公開サイトで揃う</p>
      </div>

      <AnniversaryForm
        action={createAnniversaryAction}
        articles={articles}
        asset={asset}
        initial={{
          date,
          title: sp.title ?? "",
          description: "",
          sourceUrl: "",
          articleId: "",
          classification: "internal",
        }}
        submitLabel="登録する"
        pendingLabel="登録中..."
      />
    </div>
  );
}
