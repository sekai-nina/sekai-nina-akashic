import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { listBlogQuoteProgress } from "@/lib/domain/blog-quotes";
import { BlogQuoteList } from "./blog-quote-list";

/**
 * 本人ブログ → 言葉記事の進捗 (#206)。
 * ブログ 1 本 = 1 行で、未着手 / 作業中 / 記事化済み / 対象外 を出し、そこから記事づくりに入る。
 */
export default async function QuotesPage() {
  const session = await auth();
  if (!session?.user) notFound();
  const rows = await listBlogQuoteProgress(session.user);
  const editable = session.user.role === "admin" || session.user.role === "member";

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">言葉記事</h1>
        <p className="text-slate-500 text-sm mt-1">
          本人ブログ 1 本につき言葉記事 1 本。範囲を選んで記事にし、名言集に載せる一節を選ぶ
        </p>
      </div>
      <BlogQuoteList rows={rows} editable={editable} />
    </div>
  );
}
