import { redirect } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { LlmProvider, type StatusLevel } from "@prisma/client";
import { auth } from "@/lib/auth";
import {
  getFeatureBreakdown,
  getFeatureTotals,
  getProviderSummaries,
  HISTORY_DAYS,
  ALL_PROVIDERS,
} from "@/lib/costs/report";
import { isAnthropicAdminConfigured, isOpenAiAdminConfigured } from "@/lib/costs/providers";
import { CREDIT_WARN_DAYS, fillMissingDays } from "@/lib/costs/summary";
import { describeRate, formatMoney } from "@/lib/costs/currency";
import {
  LLM_PROVIDER_BILLING_URLS,
  LLM_PROVIDER_LABELS,
  LLM_USAGE_SOURCE_LABELS,
  STATUS_LEVEL_BADGE,
  STATUS_LEVEL_LABELS,
  addDaysToDateString,
  formatDate,
  formatRelative,
  toJstDateOnly,
} from "@/lib/utils";
import { SnapshotForm } from "./snapshot-form";

// 集計は cron の取り込み結果を毎回読む
export const dynamic = "force-dynamic";

/** 補充を促す状態か (注意・異常のときだけボタンを強調する) */
function needsTopUp(status: StatusLevel): boolean {
  return status === "warn" || status === "error";
}

function usd(value: number | null | undefined, digits = 2): string {
  if (value == null) return "—";
  return `$${value.toFixed(digits)}`;
}

/**
 * LLM の利用コストと残クレジット (#117)。**admin のみ。**
 *
 * 金額の出どころは 2 つ: プロバイダの Admin API から引いた確定額 (LlmCostDaily) と、
 * 各呼び出し側が報告したトークンを単価表で換算した推定額 (LlmUsageDaily)。
 * 残高を返す API は 3 社とも無いので、観測した残高 (CreditSnapshot) から支出を引いて推定する。
 */
export default async function CostsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "admin") redirect("/dashboard");

  const now = new Date();
  const [summaries, totals, breakdown] = await Promise.all([
    getProviderSummaries(now),
    getFeatureTotals(now),
    getFeatureBreakdown(now),
  ]);
  const maxFeatureUsd = Math.max(0.000001, ...totals.map((t) => t.costUsd ?? 0));
  // グラフの横軸を 3 プロバイダで揃える (記録の無い日は 0 で埋める)
  const today = toJstDateOnly(now)!;
  const chartFrom = addDaysToDateString(today, -HISTORY_DAYS + 1);
  const charts = new Map(summaries.map((s) => [s.provider, fillMissingDays(s.daily, chartFrom, today)]));
  const maxDaily = Math.max(0.0001, ...summaries.flatMap((s) => s.daily.map((d) => d.usd)));
  const adminKeys = [
    { label: LLM_PROVIDER_LABELS[LlmProvider.openai], ok: isOpenAiAdminConfigured() },
    { label: LLM_PROVIDER_LABELS[LlmProvider.anthropic], ok: isAnthropicAdminConfigured() },
  ];
  const missingKeys = adminKeys.filter((k) => !k.ok);
  const unpriced = summaries.flatMap((s) => s.unpricedModels.map((m) => `${LLM_PROVIDER_LABELS[s.provider]} / ${m}`));

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">コスト</h1>
        <p className="text-slate-500 text-sm mt-1">
          LLM の利用額と残クレジット。確定額はプロバイダの Admin API から、機能別の内訳は各呼び出し側の自己申告から作ります。
          残高は記録した値から支出を引いた推定です。
        </p>
      </div>

      {missingKeys.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-4 py-3 mb-6">
          {missingKeys.map((k) => k.label).join(" / ")} の Admin キーが未設定です。確定額が取り込めないため、
          自己申告のぶんだけで推定しています（コードを通らない利用は拾えません）。
          <span className="font-mono text-xs ml-1">OPENAI_ADMIN_KEY</span> /
          <span className="font-mono text-xs ml-1">ANTHROPIC_ADMIN_KEY</span> を Vercel に入れてください。
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3 mb-6">
        {summaries.map((s) => (
          <div key={s.provider} className="bg-white border border-slate-200 rounded-lg p-4">
            <div className="flex items-baseline justify-between gap-2 mb-2">
              <h2 className="font-medium text-slate-900">{LLM_PROVIDER_LABELS[s.provider]}</h2>
              <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_LEVEL_BADGE[s.judgement.status]}`}>
                {STATUS_LEVEL_LABELS[s.judgement.status]}
              </span>
            </div>
            <dl className="text-sm space-y-1">
              <div className="flex justify-between">
                <dt className="text-slate-500">今月</dt>
                <dd className="font-medium">{usd(s.monthUsd)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">1 日あたり</dt>
                <dd>{usd(s.burnPerDay, 3)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">推定残高</dt>
                <dd className="font-medium">{usd(s.balanceUsd)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">残り日数</dt>
                <dd className={s.days != null && s.days < CREDIT_WARN_DAYS ? "font-semibold text-amber-700" : ""}>
                  {s.days == null ? "—" : `約 ${s.days} 日`}
                </dd>
              </div>
            </dl>
            <p className="text-[11px] text-slate-400 mt-2">
              {s.snapshotAt ? (
                <>
                  残高の記録: {formatDate(s.snapshotAt, true)}（{formatRelative(s.snapshotAt, now)}）
                  {/* 円で記録したものを USD で見せているので、元の額と使ったレートを添える */}
                  {s.snapshotSource && s.snapshotSource.currency !== "USD" && (
                    <>
                      <br />
                      {formatMoney(s.snapshotSource.amount, s.snapshotSource.currency)} /{" "}
                      {describeRate(s.snapshotSource.currency, s.snapshotSource.unitsPerUsd)}
                    </>
                  )}
                </>
              ) : (
                "残高が未登録"
              )}
            </p>
            {/* 補充はプロバイダの画面でしかできないので、判断した流れのまま飛べるようにする */}
            <a
              href={LLM_PROVIDER_BILLING_URLS[s.provider]}
              target="_blank"
              rel="noopener noreferrer"
              className={`mt-3 inline-flex items-center gap-1 px-3 py-1.5 rounded text-sm font-medium ${
                needsTopUp(s.judgement.status)
                  ? "bg-slate-900 text-white hover:bg-slate-800"
                  : "border border-slate-300 text-slate-700 hover:bg-slate-50"
              }`}
            >
              補充する
              <ExternalLink size={12} />
            </a>
          </div>
        ))}
      </div>

      <section className="mb-6">
        <h2 className="text-sm font-semibold text-slate-700 mb-2">日次の推移（{HISTORY_DAYS} 日）</h2>
        <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-4">
          {summaries.map((s) => (
            <div key={s.provider}>
              <p className="text-xs text-slate-500 mb-1">{LLM_PROVIDER_LABELS[s.provider]}</p>
              {s.daily.length === 0 ? (
                <p className="text-xs text-slate-400">記録なし</p>
              ) : (
                <div className="flex items-end gap-0.5 h-16">
                  {(charts.get(s.provider) ?? []).map((d) => (
                    <div
                      key={d.date}
                      title={`${d.date}: ${usd(d.usd, 4)}`}
                      className={`flex-1 rounded-sm min-h-[2px] ${d.usd > 0 ? "bg-slate-300 hover:bg-slate-400" : "bg-slate-100"}`}
                      style={{ height: `${Math.max(2, (d.usd / maxDaily) * 100)}%` }}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="mb-6">
        <h2 className="text-sm font-semibold text-slate-700 mb-1">何にかかっているか（{HISTORY_DAYS} 日）</h2>
        <p className="text-xs text-slate-500 mb-2">
          機能ごとの合計。
          <span className="font-medium">「自己申告」と「プロバイダ」は同じ利用を別の見方で数えているので足し合わせないでください</span>
          （自己申告は呼び出し側が報告した機能単位、プロバイダは API キー単位。キーを共有している機能は
          プロバイダ側では分かれません）。
        </p>
        {totals.length === 0 ? (
          <p className="text-sm text-slate-400 py-6 text-center bg-white border border-slate-200 rounded-lg">
            まだ記録がありません
          </p>
        ) : (
          <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
            {totals.map((t) => (
              <div key={`${t.provider}-${t.feature}-${t.source}`} className="px-4 py-2">
                <div className="flex items-baseline gap-2 text-sm">
                  <span className="font-mono text-xs">{t.feature}</span>
                  <span className="text-[11px] text-slate-400">
                    {LLM_PROVIDER_LABELS[t.provider]} · {LLM_USAGE_SOURCE_LABELS[t.source]}
                    {t.requests > 0 && ` · ${t.requests.toLocaleString("ja-JP")} 回`}
                  </span>
                  <span className="ml-auto font-medium">
                    {t.costUsd == null ? <span className="text-amber-700 text-xs">価格未登録</span> : usd(t.costUsd, 4)}
                  </span>
                </div>
                <div className="mt-1 h-1.5 bg-slate-100 rounded-sm overflow-hidden">
                  <div
                    className="h-full bg-slate-400"
                    style={{ width: `${Math.max(1, ((t.costUsd ?? 0) / maxFeatureUsd) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mb-6">
        <h2 className="text-sm font-semibold text-slate-700 mb-1">機能 × モデルの内訳（{HISTORY_DAYS} 日）</h2>
        <p className="text-xs text-slate-500 mb-2">
          自己申告とプロバイダの usage API から。
          <span className="font-medium">同じ利用が両方に出ることがあるので足し合わせないでください</span>
          （出どころ列で分けています）。確定額とは端数が合わないことがあります（単価表での換算のため）。
        </p>
        {breakdown.length === 0 ? (
          <p className="text-sm text-slate-400 py-6 text-center bg-white border border-slate-200 rounded-lg">
            まだ報告がありません
          </p>
        ) : (
          <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 border-b border-slate-100">
                  <th className="text-left font-normal px-4 py-2">機能</th>
                  <th className="text-left font-normal px-4 py-2">モデル</th>
                  <th className="text-left font-normal px-4 py-2">出どころ</th>
                  <th className="text-right font-normal px-4 py-2">回数</th>
                  <th className="text-right font-normal px-4 py-2">入力</th>
                  <th className="text-right font-normal px-4 py-2">出力</th>
                  <th className="text-right font-normal px-4 py-2">金額</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((r) => (
                  <tr key={`${r.provider}-${r.feature}-${r.model}-${r.source}`} className="border-b border-slate-50 last:border-0">
                    <td className="px-4 py-1.5 font-mono text-xs">{r.feature}</td>
                    <td className="px-4 py-1.5 font-mono text-xs text-slate-500">{r.model}</td>
                    <td className="px-4 py-1.5 text-xs text-slate-400">{LLM_USAGE_SOURCE_LABELS[r.source]}</td>
                    <td className="px-4 py-1.5 text-right text-slate-500">{r.requests.toLocaleString("ja-JP")}</td>
                    <td className="px-4 py-1.5 text-right text-slate-500">{r.inputTokens.toLocaleString("ja-JP")}</td>
                    <td className="px-4 py-1.5 text-right text-slate-500">{r.outputTokens.toLocaleString("ja-JP")}</td>
                    <td className="px-4 py-1.5 text-right font-medium">
                      {r.costUsd == null ? <span className="text-amber-700 text-xs">価格未登録</span> : usd(r.costUsd, 4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {unpriced.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-4 py-3 mb-6">
          単価表に無いモデルがあります（金額に入っていません）:{" "}
          <span className="font-mono text-xs">{unpriced.join(", ")}</span>。
          <span className="font-mono text-xs ml-1">src/lib/costs/pricing.ts</span> に足してください。
        </div>
      )}

      <SnapshotForm providers={ALL_PROVIDERS} />
    </div>
  );
}
