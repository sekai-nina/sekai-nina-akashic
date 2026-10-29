import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { listArticlePrompts } from "@/lib/domain/article-prompt-setting";
import { SubmitButton } from "@/components/submit-button";
import { ARTICLE_TEMPLATE_LABELS } from "@/lib/utils";
import { resetArticlePrompt, saveArticlePrompt } from "./actions";

/**
 * 記事テンプレートの AI プロンプト。
 *
 * 企画 → 記事で本文を AI に書かせるとき (おでかけ・スナップ・言葉 (状況つき)) のルール文を
 * 確認・修正する。**テンプレートごとに 1 つ**で、そのテンプレートのすべての生成に効く。
 */
export const dynamic = "force-dynamic";

function formatJst(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default async function AdminArticlePromptsPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const session = await auth();
  if (!session?.user) notFound();
  if (session.user.role !== "admin") notFound();

  const [{ t }, prompts] = await Promise.all([searchParams, listArticlePrompts()]);
  const current = prompts.find((p) => p.template === t) ?? prompts[0];
  if (!current) notFound();

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">記事 AI のプロンプト</h1>
        <p className="text-slate-500 text-sm mt-1">
          企画から記事を作るとき、本文を AI（Claude）に書かせるテンプレートのルール文。
          <strong className="text-slate-700">そのテンプレートのすべての生成に効きます</strong>
          （保存した次の生成から）。
        </p>
      </div>

      <nav className="flex flex-wrap gap-1 mb-4 border-b border-slate-200">
        {prompts.map((p) => (
          <Link
            key={p.template}
            href={`/admin/article-prompts?t=${p.template}`}
            className={
              "px-3 py-2 text-sm -mb-px border-b-2 " +
              (p.template === current.template
                ? "border-slate-900 text-slate-900 font-medium"
                : "border-transparent text-slate-500 hover:text-slate-700")
            }
          >
            {ARTICLE_TEMPLATE_LABELS[p.template]}
            {!p.isDefault && <span className="ml-1 text-xs text-amber-600">変更済み</span>}
          </Link>
        ))}
      </nav>

      <section className="border border-slate-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-slate-900">
          {ARTICLE_TEMPLATE_LABELS[current.template]} のルール文
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          {current.isDefault ? "いまは組み込みの既定の文面です。" : "既定から変更済みです。"}
          空にして保存すると既定に戻ります。
          {current.updatedAt && (
            <span className="text-slate-400">
              {" "}
              最終更新 {formatJst(current.updatedAt)}
              {current.updatedByName ? ` · ${current.updatedByName}` : ""}
            </span>
          )}
        </p>
        <form action={saveArticlePrompt} className="mt-3">
          <input type="hidden" name="template" value={current.template} />
          <textarea
            key={current.template}
            name="rules"
            rows={32}
            defaultValue={current.rules}
            aria-label={`${ARTICLE_TEMPLATE_LABELS[current.template]} のルール文`}
            className="w-full px-3 py-2 rounded-md border border-slate-200 bg-white font-mono text-xs text-slate-900 outline-none focus:border-slate-400"
          />
          <div className="mt-2 flex items-center gap-2">
            <SubmitButton className="h-9 px-4 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800">
              保存
            </SubmitButton>
            {!current.isDefault && (
              <SubmitButton
                formAction={resetArticlePrompt}
                className="h-9 px-3 rounded-md border border-slate-200 text-sm text-slate-700 hover:bg-slate-50"
              >
                既定に戻す
              </SubmitButton>
            )}
          </div>
        </form>

        {!current.isDefault && (
          <details className="mt-4">
            <summary className="text-xs text-slate-500 cursor-pointer">組み込みの既定を見る</summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-3 font-mono text-xs text-slate-700">
              {current.defaultRules}
            </pre>
          </details>
        )}
      </section>

      <section className="mt-6 text-xs text-slate-500 space-y-1">
        <p className="font-medium text-slate-700">AI に渡すもの（上のルール文のほか）</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>既存のタグと、公開済みの記事タイトルの一覧（タグ選び・[[リンク]] 用。記事を保存すると変わる）</li>
          <li>
            企画のタイトルと素材（ブログ・トークの本文、人が選んだ重要箇所、メモ、画像のキャプション、
            おでかけは場所候補）。素材は企画ごとに変わるのでここでは直せません
          </li>
          <li>
            返答の形（本文・タグ・日付）は JSON で固定しています。ルール文の「出力」の節を消しても形は変わりません
          </li>
        </ul>
      </section>
    </div>
  );
}
