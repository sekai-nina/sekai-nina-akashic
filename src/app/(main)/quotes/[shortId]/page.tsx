import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { auth } from "@/lib/auth";
import { getQuoteArticlePassages } from "@/lib/domain/blog-quotes";
import { PassageToggles } from "./passage-toggles";

interface Props {
  params: Promise<{ shortId: string }>;
}

/**
 * 言葉記事の「名言集に載せる一節」を選ぶ (#206)。
 * 引用ブロック (= 抜粋) ごとに `{q}…{/q}` を付け外しする。反映は記事の push。
 */
export default async function QuotePassagesPage({ params }: Props) {
  const { shortId } = await params;
  const session = await auth();
  if (!session?.user) notFound();
  const article = await getQuoteArticlePassages(shortId);
  if (!article) notFound();
  const editable = session.user.role === "admin" || session.user.role === "member";

  return (
    <div className="max-w-3xl mx-auto">
      <Link href="/quotes" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600">
        <ArrowLeft size={14} /> 言葉記事
      </Link>
      <h1 className="mt-2 text-lg font-semibold text-slate-900">{article.title}</h1>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-slate-500">
        <span>名言集に載る一節 {article.quoteCount}</span>
        {article.dirty && <span className="text-amber-700">未 push (サイトはまだ前の状態)</span>}
        <Link href={`/articles/${article.shortId}`} className="inline-flex items-center gap-0.5 hover:underline">
          記事を開く <ExternalLink size={12} />
        </Link>
        <Link href="/articles/push" className="hover:underline">
          push へ
        </Link>
      </div>
      <p className="mt-4 text-xs text-slate-500">
        引用 (抜粋) ごとに「名言集に載せる」を選ぶと、その引用全体が {"{q}…{/q}"} で囲まれます。一部だけを載せたいときは記事の編集画面で直してください。
      </p>
      <PassageToggles shortId={article.shortId} passages={article.passages} editable={editable} />
    </div>
  );
}
