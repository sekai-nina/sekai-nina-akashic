import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { listImportCandidates } from "@/lib/domain/meetgreet-import";
import { ImportForm } from "./import-form";

/**
 * 過去のドシエの取り込み (#118)。
 * /meetgreets を作る前から手で作っていたドシエと X レポ収集を拾い直す。
 */
export default async function ImportMeetGreetsPage() {
  const session = await auth();
  if (!session?.user) notFound();

  const candidates = await listImportCandidates(session.user);

  return (
    <div className="max-w-4xl mx-auto">
      <Link href="/meetgreets" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600">
        <ArrowLeft size={14} /> ミーグリ一覧へ
      </Link>
      <h1 className="text-2xl font-bold text-slate-900 mt-2 mb-1">過去のドシエを取り込む</h1>
      <p className="text-slate-500 text-sm mb-6">
        ミーグリごとに手で作ってあったドシエと X レポ収集を、そのままミーグリとして扱えるようにします。
        素材とレポは集め直しません（<strong>X の収集は走りません</strong>）。取り込み済みのものは出ません。
      </p>
      <ImportForm candidates={candidates} />
    </div>
  );
}
