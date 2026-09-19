/**
 * 残高を記録するときの通貨。
 *
 * **社内の計算はすべて USD で持つ。** 単価表 (`pricing.ts`) も各社の公表価格も USD で、
 * OpenAI / Anthropic のコスト API も USD で返すため。ところが Google Cloud の請求通貨は
 * アカウントによって円で、AI Studio の残高も円で表示される。そこで**目視した金額と通貨を
 * そのまま残したうえで、USD に換算した値を `balanceUsd` に入れる**。
 *
 * DB を触らないモジュールに置く (これを使うテストが `@/lib/db` を巻き込まないため)。
 */

export const CURRENCIES = ["USD", "JPY"] as const;

export type Currency = (typeof CURRENCIES)[number];

export const CURRENCY_LABELS: Record<Currency, string> = {
  USD: "USD ($)",
  JPY: "JPY (¥)",
};

/**
 * 「1 USD が何単位か」の既定値。
 *
 * **為替 API は引かない。** 残高の推定に効くのは数 % で、外部依存を 1 つ増やして
 * 取り込みが落ちるほうが痛い。ズレていたら記録するときにフォームで上書きできる。
 * 大きく動いたらこの値を直す (最終確認: 2026-09-19)。
 */
export const DEFAULT_UNITS_PER_USD: Record<Currency, number> = {
  USD: 1,
  JPY: 155,
};

/** レートの上限。桁を間違えて入れた値で残高を壊さないための歯止め */
export const MAX_UNITS_PER_USD = 100_000;

export function isCurrency(value: string): value is Currency {
  return (CURRENCIES as readonly string[]).includes(value);
}

/**
 * 目視した金額を USD に直す。`balanceUsd` が Decimal(12,2) なので 2 桁で丸める。
 * レートが不正なら null (= 記録させない)。
 */
export function toUsd(amount: number, unitsPerUsd: number): number | null {
  if (!Number.isFinite(amount) || amount < 0) return null;
  if (!Number.isFinite(unitsPerUsd) || unitsPerUsd <= 0 || unitsPerUsd > MAX_UNITS_PER_USD) return null;
  return Math.round((amount / unitsPerUsd) * 100) / 100;
}

/** 「¥3,000」「$30.00」のように、目視した通貨のまま見せる */
export function formatMoney(amount: number, currency: Currency): string {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency,
    // 円は小数を出さない (各社の画面もそう出している)
    maximumFractionDigits: currency === "JPY" ? 0 : 2,
  }).format(amount);
}

/** 「1 USD = 155 JPY」。USD のときは換算していないので空 */
export function describeRate(currency: Currency, unitsPerUsd: number): string {
  if (currency === "USD") return "";
  return `1 USD = ${unitsPerUsd} ${currency}`;
}
