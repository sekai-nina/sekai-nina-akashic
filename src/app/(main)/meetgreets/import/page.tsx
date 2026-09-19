import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { listArticleLinkCandidates, listImportCandidates } from "@/lib/domain/meetgreet-import";
import { ImportForm } from "./import-form";
import { ArticleLinkForm } from "./link-form";

/**
 * 過去のドシエの取り込み (#118)。
 * /meetgreets を作る前から手で作っていたドシエと X レポ収集を拾い直す。
 */
export default async function ImportMeetGreetsPage() {
  const session = await auth();
  if (!session?.user) notFound();

  const [candidates, linkCandidates] = await Promise.all([
    listImportCandidates(session.user),
    listArticleLinkCandidates(session.user),
  ]);

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

      <h2 className="text-sm font-medium text-slate-500 mt-10 mb-2">公開済みの記事を紐づける</h2>
      <p className="text-slate-500 text-sm mb-4">
        <span className="font-mono text-xs">/meetgreets</span>{" "}
        を作る前に書いた記事は frontmatter にドシエの ID を持っているので、
        それで突き合わせます。紐づけると、以降はドシエが増えたぶんを差分として追記できるようになります。
      </p>
      <ArticleLinkForm candidates={linkCandidates} />
    </div>
  );
}
