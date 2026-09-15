import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { previewArticlePush } from "@/lib/domain/articles";
import { defaultCommitSubject, PUSH_CONFLICT_LABELS, type PushPlanItem } from "@/lib/articles/push";
import { ARTICLE_SOURCE_STATUS_LABELS } from "@/lib/utils";
import { PushForm } from "./push-form";

// Server Action (push) は GitHub と 5 往復 + tree の POST (~800KB) を直列で行う。
// 初回の全件正規化 (334 本) は 10 秒を超えうるので、関数の上限を明示しておく
export const maxDuration = 120;

function ArticleRow({ item, note }: { item: PushPlanItem; note?: React.ReactNode }) {
  const a = item.article;
  return (
    <div className="px-4 py-2.5 flex items-baseline gap-2 flex-wrap">
      <Link href={`/articles/${a.shortId}`} className="font-medium text-slate-900 hover:underline">
        {a.title || a.path}
      </Link>
      <span className="text-xs text-slate-400">{a.path}</span>
      {note && <span className="text-xs text-slate-600 ml-auto">{note}</span>}
    </div>
  );
}

function Section({
  title,
  badge,
  items,
  children,
  renderNote,
}: {
  title: string;
  /** 件数バッジの色。他ページの状態バッジ (bg-*-100 text-*-700) に合わせる */
  badge: string;
  items: PushPlanItem[];
  children?: React.ReactNode;
  renderNote?: (item: PushPlanItem) => React.ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold text-slate-700 mb-1 flex items-center gap-2">
        {title}
        <span className={`text-xs px-1.5 py-0.5 rounded font-normal ${badge}`}>{items.length} 本</span>
      </h2>
      {children && <p className="text-xs text-slate-500 mb-2">{children}</p>}
      <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
        {items.map((item) => (
          <ArticleRow key={item.article.id} item={item} note={renderNote?.(item)} />
        ))}
      </div>
    </section>
  );
}

/**
 * 未 push (dirty) の記事を GitHub に一括で書き出す画面。**admin のみ。**
 *
 * dirty な記事を全件組み立てて GitHub の tree と突き合わせ、
 * 「衝突 / 公開以外の出典あり / push 可 / 内容が同じ」に分けて見せる。
 * 実行 (`pushArticlesAction`) はこの計画を使い回さず commit 直前に作り直す。
 */
export default async function ArticlePushPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") redirect("/articles");

  const preview = await previewArticlePush();
  const plan = preview.state === "ready" ? preview.plan : null;
  const total = plan ? plan.ok.length + plan.unchanged.length + plan.blocked.length + plan.conflicts.length : 0;

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <Link href="/articles" className="text-sm text-slate-500 hover:underline">
          ← 記事一覧
        </Link>
        <h1 className="text-2xl font-bold text-slate-900 mt-2">GitHub へ push</h1>
        <p className="text-slate-500 text-sm mt-1">
          未 push の記事を <span className="font-mono">{preview.repo}</span> の main に 1 コミットで書き出します。
          frontmatter は DB から丸ごと生成し直します (公開されるのは「公開」の出典だけです)
        </p>
      </div>

      {preview.state === "unconfigured" && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-4 py-3 mb-6">
          <span className="font-mono">ARTICLES_GITHUB_TOKEN</span> が設定されていないため push できません
          (未 push の記事 {preview.dirtyCount} 本)。sekai-nina-public に Contents: Read and write を持つ
          fine-grained PAT を Vercel の環境変数に追加してください
        </div>
      )}

      {preview.state === "error" && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-6">
          GitHub から現在の状態を取得できません (未 push の記事 {preview.dirtyCount} 本): {preview.message}
        </div>
      )}

      {preview.state === "ready" && plan && total === 0 && (
        <p className="text-sm text-slate-400 py-8 text-center">未 push の記事はありません</p>
      )}

      {preview.state === "ready" && plan && total > 0 && (
        <>
          <p className="text-sm text-slate-600 mb-4">
            <span className="text-red-700">衝突 {plan.conflicts.length}</span>
            {" / "}
            <span className="text-amber-700">公開以外の出典あり {plan.blocked.length}</span>
            {" / "}
            <span className="text-emerald-700 font-medium">push 可 {plan.ok.length}</span>
            {" / "}
            <span className="text-slate-500">内容が同じ {plan.unchanged.length}</span>
            <span className="text-xs text-slate-400 ml-3">
              main の先頭: <span className="font-mono">{preview.head.commitSha.slice(0, 7)}</span>
            </span>
          </p>

          <PushForm
            count={plan.ok.length}
            unchangedCount={plan.unchanged.length}
            defaultSubject={defaultCommitSubject(plan.ok.length)}
          />

          <Section
            title="衝突"
            badge="bg-red-100 text-red-700"
            items={plan.conflicts}
            renderNote={(i) => (i.kind === "conflict" ? PUSH_CONFLICT_LABELS[i.reason] : null)}
          >
            取り込んだ時点から GitHub 側が変わっている (または blob SHA が無い) 記事です。push からは除外します。
            checkout を pull して <span className="font-mono">pnpm cli:import-articles --apply</span> で DB 側を作り直すと解消します
            (DB 上の未 push の編集は上流の変更で上書きされます)。GitHub 側でファイルが消えている場合は取り込みでは解消しないので、
            ファイルを復元するか、記事を Prisma Studio で削除してください
          </Section>

          <Section
            title="公開以外の出典あり"
            badge="bg-amber-100 text-amber-700"
            items={plan.blocked}
            renderNote={(i) =>
              i.kind === "blocked" ? `脚注 ${i.article.blockedSourceNos.map((n) => `^[${n ?? "-"}]`).join(" ")}` : null
            }
          >
            {ARTICLE_SOURCE_STATUS_LABELS.applied} / {ARTICLE_SOURCE_STATUS_LABELS.unresolved} なのに機密レベルが「公開」でない出典があります。
            本文が参照している脚注が消えてしまうので push しません。出典を「公開」にするか外してから、この画面を開き直してください
          </Section>

          <Section
            title="push 可"
            badge="bg-emerald-100 text-emerald-700"
            items={plan.ok}
            renderNote={(i) => (i.kind === "ok" && i.isNew ? "新規ファイル" : null)}
          />

          <Section title="内容が同じ" badge="bg-slate-100 text-slate-600" items={plan.unchanged}>
            組み立てた Markdown が GitHub 側と同じ blob です。コミットには載せず、push 時に未 push の印だけ外します
          </Section>
        </>
      )}
    </div>
  );
}
