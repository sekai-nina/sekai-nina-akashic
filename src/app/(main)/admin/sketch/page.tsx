import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { getSketchSetting, listConfirmedSketches } from "@/lib/domain/sketch-setting";
import { SubmitButton } from "@/components/submit-button";
import { pickStyleReference, resetSketchPrompt, resetStyleReference, saveSketchPrompt } from "./actions";
import { StyleReferenceUpload } from "./style-upload";

/**
 * スケッチ生成の設定 (#136)。
 *
 * プロンプト本体と画風の見本はコードに埋め込みで、直すのにデプロイが要った。
 * **全体で 1 つの設定**で、すべての回の生成に効く。回ごとの違いは各ミーグリ画面の
 * 「この回の追加指示」で足す。
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

export default async function AdminSketchPage() {
  const session = await auth();
  if (!session?.user) notFound();
  if (session.user.role !== "admin") notFound();

  const [setting, confirmed] = await Promise.all([
    getSketchSetting(),
    listConfirmedSketches(session.user.clearance),
  ]);

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">スケッチ生成の設定</h1>
        <p className="text-slate-500 text-sm mt-1">
          ミーグリの服装スケッチを作るときのプロンプトと、画風の見本。
          <strong className="text-slate-700">すべての回に効きます</strong>
          （回ごとの違いは各ミーグリ画面の「この回の追加指示」で足してください）。
        </p>
        {setting.updatedAt && (
          <p className="text-xs text-slate-400 mt-1">
            最終更新 {formatJst(setting.updatedAt)}
            {setting.updatedByName ? ` · ${setting.updatedByName}` : ""}
          </p>
        )}
      </div>

      <section className="border border-slate-200 rounded-lg p-5 mb-6">
        <h2 className="text-sm font-semibold text-slate-900">画風の見本</h2>
        <p className="text-xs text-slate-500 mt-1">
          毎回この 1 枚を参考に描かせています。直前の生成結果を参照し続けると、コピーのコピーで
          画風が少しずつずれていくため、回をまたいで同じものを使います。
          <strong className="text-slate-700">
            見本は生成のたびに外部 AI（OpenAI）へ送られ、ミーグリ画面を開ける人全員に見えます。
          </strong>
          機密レベルが internal を超えるものは選べません。
        </p>

        <div className="mt-3 flex items-start gap-4">
          {setting.styleReferenceUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={setting.styleReferenceUrl}
              alt="いま使っている画風の見本"
              className="w-56 rounded border border-slate-200 bg-white"
            />
          ) : (
            <span className="flex h-32 w-56 items-center justify-center rounded border border-slate-200 bg-slate-50 text-xs text-slate-400">
              R2 が未設定のため表示できません
            </span>
          )}
          <div className="text-xs text-slate-500 space-y-2">
            <p>{setting.isDefaultStyleReference ? "既定の見本を使っています。" : "差し替え済みの見本です。"}</p>
            <p className="break-all text-slate-400">{setting.styleReferenceKey}</p>
            {!setting.isDefaultStyleReference && (
              <form action={resetStyleReference}>
                <SubmitButton className="h-8 px-3 rounded-md border border-slate-200 text-xs text-slate-700 hover:bg-slate-50">
                  既定の見本に戻す
                </SubmitButton>
              </form>
            )}
          </div>
        </div>

        <StyleReferenceUpload />

        {confirmed.length > 0 && (
          <div className="mt-5">
            <p className="text-xs text-slate-600 mb-2">確定済みスケッチから選ぶ</p>
            <ul className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {confirmed.map((s) => (
                <li key={s.key}>
                  <form action={pickStyleReference}>
                    <input type="hidden" name="key" value={s.key} />
                    <SubmitButton
                      className={
                        "w-full flex-col items-stretch rounded-md overflow-hidden border-2 text-left " +
                        (s.key === setting.styleReferenceKey
                          ? "border-emerald-500"
                          : "border-transparent hover:border-slate-300")
                      }
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={s.url} alt={s.label} className="w-full bg-slate-100" />
                      <span className="block px-1 py-1 text-[11px] text-slate-500 truncate">
                        {s.label}
                      </span>
                    </SubmitButton>
                  </form>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="border border-slate-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-slate-900">プロンプト</h2>
        <p className="text-xs text-slate-500 mt-1">
          画像生成に渡す本文。
          {setting.isDefaultPrompt ? "いまは既定の文面です。" : "既定から変更済みです。"}
          空にして保存すると既定に戻ります。
        </p>
        <form action={saveSketchPrompt} className="mt-3">
          <textarea
            name="prompt"
            rows={20}
            defaultValue={setting.prompt}
            aria-label="スケッチのプロンプト"
            className="w-full px-3 py-2 rounded-md border border-slate-200 bg-white font-mono text-xs text-slate-900 outline-none focus:border-slate-400"
          />
          <div className="mt-2 flex items-center gap-2">
            <SubmitButton className="h-9 px-4 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800">
              保存
            </SubmitButton>
            {!setting.isDefaultPrompt && (
              <SubmitButton
                formAction={resetSketchPrompt}
                className="h-9 px-3 rounded-md border border-slate-200 text-sm text-slate-700 hover:bg-slate-50"
              >
                既定に戻す
              </SubmitButton>
            )}
          </div>
        </form>
      </section>

      <p className="mt-6 text-xs text-slate-400">
        生成そのものは各ミーグリの画面から行います →{" "}
        <Link href="/meetgreets" className="hover:underline">
          ミーグリ一覧
        </Link>
      </p>
    </div>
  );
}
