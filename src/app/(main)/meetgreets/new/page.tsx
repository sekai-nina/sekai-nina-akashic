import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { todayJst } from "@/lib/utils";
import { NewMeetGreetForm } from "./new-form";

export default async function NewMeetGreetPage() {
  const session = await auth();
  if (!session?.user) notFound();

  return (
    <div className="max-w-2xl mx-auto">
      <Link href="/meetgreets" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600">
        <ArrowLeft size={14} /> ミーグリ一覧へ
      </Link>
      <h1 className="text-2xl font-bold text-slate-900 mt-2 mb-1">ミーグリを追加</h1>
      <p className="text-slate-500 text-sm mb-6">
        作成すると、素材のドシエと X レポ収集 (当日〜翌日) が自動で作られ、X の収集を 1 回走らせます。
      </p>
      <NewMeetGreetForm defaultDate={todayJst()} />
    </div>
  );
}
