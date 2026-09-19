import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { listLinkableDossiers } from "@/lib/domain/meetgreet-import";
import { REPORT_WINDOW_DAYS } from "@/lib/meetgreet/config";
import { todayJst } from "@/lib/utils";
import { NewMeetGreetForm } from "./new-form";



export default async function NewMeetGreetPage() {
  const session = await auth();
  if (!session?.user) notFound();

  // 既に手で作ってあるドシエを選べるようにする (#118)
  const dossiers = await listLinkableDossiers(session.user);

  return (
    <div className="max-w-2xl mx-auto">
      <Link href="/meetgreets" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600">
        <ArrowLeft size={14} /> ミーグリ一覧へ
      </Link>
      <h1 className="text-2xl font-bold text-slate-900 mt-2 mb-1">ミーグリを追加</h1>
      <p className="text-slate-500 text-sm mb-6">
        素材のドシエと X レポ収集 (当日〜
        {REPORT_WINDOW_DAYS === 1 ? "翌日" : `${REPORT_WINDOW_DAYS} 日後`}) を用意します。
        <strong>X の収集はここでは走りません</strong> — 作成後の「X レポ」から実行してください。
      </p>
      <NewMeetGreetForm defaultDate={todayJst()} dossiers={dossiers} />
    </div>
  );
}
