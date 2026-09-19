"use server";

import { revalidatePath } from "next/cache";
import { LlmProvider } from "@prisma/client";
import { requireRole } from "@/lib/auth/require-role";
import { prisma } from "@/lib/db";
import { ingestAllProviders } from "@/lib/costs/providers";
import { DEFAULT_UNITS_PER_USD, formatMoney, isCurrency, toUsd } from "@/lib/costs/currency";
import { logAudit } from "@/lib/domain/audit";

export type CostActionState = { ok: true; message: string } | { ok: false; error: string };

/**
 * 観測した残高を 1 行足す。**admin のみ。**
 *
 * 入金したら「入金後の残高」を入れ直す。ズレに気づいたときも入れ直せば、
 * 以降はその行を起点に再計算されるので自己補正になる。
 */
export async function addCreditSnapshotAction(input: {
  provider: string;
  amount: string;
  /** 目視した通貨 (USD / JPY)。省略時は USD */
  currency?: string;
  /** 1 USD が何単位か。省略時は通貨ごとの既定値 */
  unitsPerUsd?: string;
  observedAt: string;
  note: string;
}): Promise<CostActionState> {
  const user = await requireRole(["admin"]);

  if (!Object.values(LlmProvider).includes(input.provider as LlmProvider)) {
    return { ok: false, error: "プロバイダが不正です" };
  }
  const currency = input.currency ?? "USD";
  if (!isCurrency(currency)) return { ok: false, error: "通貨が不正です" };

  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, error: "残高は 0 以上の数値で入れてください" };
  }
  const unitsPerUsd = input.unitsPerUsd ? Number(input.unitsPerUsd) : DEFAULT_UNITS_PER_USD[currency];
  // **換算に失敗したら記録しない。** 0 で割った Infinity を残高に入れると判定ごと壊れる
  const balance = toUsd(amount, unitsPerUsd);
  if (balance == null) {
    return { ok: false, error: "為替レートが不正です (1 USD = いくらかを正の数で入れてください)" };
  }
  // datetime-local はローカル (= 手元の端末) の壁時計。空なら今
  const observedAt = input.observedAt ? new Date(input.observedAt) : new Date();
  if (Number.isNaN(observedAt.getTime())) return { ok: false, error: "日時が不正です" };
  if (observedAt.getTime() > Date.now() + 60_000) return { ok: false, error: "未来の日時は入れられません" };

  let row;
  try {
    row = await prisma.creditSnapshot.create({
      data: {
        provider: input.provider as LlmProvider,
        balanceUsd: balance,
        amount,
        currency,
        unitsPerUsd,
        observedAt,
        note: input.note.slice(0, 200),
        createdById: user.id,
      },
    });
  } catch (e) {
    // Decimal(12,2) を超える桁などはここで落ちる。握らないとフォームに何も出ない
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  await logAudit({
    actorId: user.id,
    action: "credit.snapshot",
    targetType: "CreditSnapshot",
    targetId: row.id,
    metadata: { provider: input.provider, balanceUsd: balance, amount, currency, unitsPerUsd },
  });
  revalidatePath("/costs");
  const shown = currency === "USD" ? `$${balance.toFixed(2)}` : `${formatMoney(amount, currency)} = $${balance.toFixed(2)}`;
  return { ok: true, message: `残高を記録しました (${shown})` };
}

/** プロバイダから今すぐ取り込む。**admin のみ。** cron と同じ処理 */
export async function ingestCostsNowAction(): Promise<CostActionState> {
  await requireRole(["admin"]);
  try {
    const results = await ingestAllProviders(3);
    revalidatePath("/costs");
    const parts = results.map((r) =>
      r.skipped ? `${r.provider}: Admin キー未設定` : r.error ? `${r.provider}: 失敗 (${r.error})` : `${r.provider}: ${r.days} 日分`,
    );
    const failed = results.some((r) => r.error);
    return failed ? { ok: false, error: parts.join(" / ") } : { ok: true, message: parts.join(" / ") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
