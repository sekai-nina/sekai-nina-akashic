import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getAiSetting } from "@/lib/domain/ai-setting";
import { SubmitButton } from "@/components/submit-button";
import { toggleAi } from "./actions";

/**
 * 案内AI「ふぃたん」の運転スイッチ。
 *
 * 止めると、回答を断るだけでなくサイトから入口ごと消える（ボタンもヘッダーのリンクも）。
 * 「急に止めたい」「まだ見せたくない」のどちらにも使う。
 */
export const dynamic = "force-dynamic";

function formatJst(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

export default async function AdminAiPage() {
  const session = await auth();
  if (!session?.user) notFound();
  if (session.user.role !== "admin") notFound();

  const setting = await getAiSetting(session.user.clearance);

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">案内AI の運転</h1>
        <p className="text-slate-500 text-sm mt-1">
          サイトの案内AI「ふぃたん」を動かすかどうか。止めると、回答を断るだけでなく
          <strong className="text-slate-700">サイトから入口ごと消えます</strong>
          （右下のボタンもヘッダーのリンクも）。反映は最大1分です。
        </p>
      </div>

      <div className="border border-slate-200 rounded-lg p-5">
        <div className="flex items-center gap-3">
          <span
            className={`inline-block w-2.5 h-2.5 rounded-full ${setting.enabled ? "bg-green-500" : "bg-slate-400"}`}
            aria-hidden
          />
          <p className="font-medium text-slate-900">
            {setting.enabled ? "動いています" : "止まっています"}
          </p>
        </div>

        {setting.updatedAt && (
          <p className="text-xs text-slate-400 mt-2">
            最終変更 {formatJst(setting.updatedAt)}
            {setting.updatedByName ? `（${setting.updatedByName}）` : ""}
            {setting.note ? ` ── ${setting.note}` : ""}
          </p>
        )}

        <form action={toggleAi} className="mt-4 flex flex-wrap items-center gap-2">
          <input type="hidden" name="enabled" value={setting.enabled ? "false" : "true"} />
          <input
            type="text"
            name="note"
            placeholder={setting.enabled ? "止める理由（任意）" : "動かす理由（任意）"}
            maxLength={200}
            className="border border-slate-300 rounded px-3 py-1.5 text-sm flex-1 min-w-[16rem]"
          />
          <SubmitButton
            className={`rounded px-4 py-1.5 text-sm font-medium text-white ${
              setting.enabled ? "bg-red-600 hover:bg-red-700" : "bg-slate-900 hover:bg-slate-800"
            }`}
            pendingText="切り替え中…"
          >
            {setting.enabled ? "止める" : "動かす"}
          </SubmitButton>
        </form>
      </div>

      <p className="text-xs text-slate-400 mt-4">
        Worker はこの設定を短い間隔で見に来ます。Akashic が落ちていても、Worker は最後に
        読めた値で動き続けるので、ここが原因で AI が止まることはありません。
      </p>
    </div>
  );
}
