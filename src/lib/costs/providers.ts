import { LlmProvider } from "@prisma/client";
import { toJstDateOnly } from "@/lib/utils";
import { replaceProviderUsage, upsertProviderCost } from "./usage";

/**
 * プロバイダの Admin API から日次コストを取り込む。
 *
 * **残高を返す API は 3 社とも無い**ので、ここで取れるのは支出だけ。残高は CreditSnapshot
 * (人が入れる) と突き合わせる。Gemini はコスト API が実質使えない (Cloud Billing の
 * エクスポートが要り、24 時間遅れる) ので、自己申告だけで見る。
 *
 * Admin キーはどちらも**通常の API キーとは別物**:
 *   - OPENAI_ADMIN_KEY    : OpenAI の組織 Admin キー (`GET /v1/organization/costs`)
 *   - ANTHROPIC_ADMIN_KEY : Anthropic の Admin キー `sk-ant-admin...`
 * 未設定ならそのプロバイダは黙ってスキップする (/status に unknown で出る)。
 *
 * **日付の粒度は UTC 日。** 両社ともバケットを UTC 深夜で切るので、ここで入る「日」は
 * JST 09:00〜翌 09:00 の 24 時間にあたる。自己申告 (true JST) とは最大 9 時間ぶんずれるが、
 * 月末の端数が動く程度なので、日次の推移とバーンレートの用途では許容する。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface IngestResult {
  provider: LlmProvider;
  /** 取り込んだ日数 */
  days: number;
  /** usage API から入れた内訳の行数 */
  usageRows: number;
  /** 未設定でスキップした */
  skipped: boolean;
  error: string | null;
}

export function isOpenAiAdminConfigured(): boolean {
  return !!process.env.OPENAI_ADMIN_KEY?.trim();
}

export function isAnthropicAdminConfigured(): boolean {
  return !!process.env.ANTHROPIC_ADMIN_KEY?.trim();
}

/** `api_key_id` → 機能名の対応 (`ANTHROPIC_KEY_FEATURES` に JSON で置く)。無ければキー ID をそのまま出す */
function anthropicKeyFeatures(): Record<string, string> {
  const raw = process.env.ANTHROPIC_KEY_FEATURES?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    console.warn("[costs] ANTHROPIC_KEY_FEATURES が JSON として読めません");
    return {};
  }
}

/** 日の頭 (UTC) に丸める。「この時刻以降に始まるバケット」なので、丸めないと一番古い日が落ちる */
function floorToUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** エラー本文に混ざりうるキーを伏せる (OpenAI の 401 は先頭数文字を返す) */
function redactKeys(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`${new URL(url).pathname} ${res.status}: ${redactKeys((await res.text()).slice(0, 200))}`);
  }
  return res.json();
}

/** ページングは使っていない。切り詰められたら気づけるようにログに残す */
function warnIfTruncated(what: string, json: unknown): void {
  if (json && typeof json === "object" && (json as { has_more?: boolean }).has_more) {
    console.warn(`[costs] ${what} の応答が途中で切れています (ページングは未対応)`);
  }
}

/**
 * OpenAI の日次コスト。`GET /v1/organization/costs` は UTC 日次バケットで
 * `{ data: [{ start_time, results: [{ amount: { value, currency } }] }] }` を返す。
 */
export async function ingestOpenAi(days: number, now: Date = new Date()): Promise<IngestResult> {
  const base: IngestResult = { provider: LlmProvider.openai, days: 0, usageRows: 0, skipped: false, error: null };
  const key = process.env.OPENAI_ADMIN_KEY?.trim();
  if (!key) return { ...base, skipped: true };

  const startTime = Math.floor(floorToUtcDay(new Date(now.getTime() - days * DAY_MS)).getTime() / 1000);
  const url = `https://api.openai.com/v1/organization/costs?start_time=${startTime}&bucket_width=1d&limit=${days + 1}`;
  try {
    const json = (await fetchJson(url, { Authorization: `Bearer ${key}` })) as {
      has_more?: boolean;
      data?: { start_time?: number; results?: { amount?: { value?: number } }[] }[];
    };
    warnIfTruncated("OpenAI costs", json);
    let count = 0;
    for (const bucket of json.data ?? []) {
      if (typeof bucket.start_time !== "number") continue;
      const dateOnly = toJstDateOnly(new Date(bucket.start_time * 1000));
      if (!dateOnly) continue;
      const amount = (bucket.results ?? []).reduce((sum, r) => sum + (r.amount?.value ?? 0), 0);
      await upsertProviderCost(dateOnly, LlmProvider.openai, amount, "openai:costs");
      count++;
    }
    return { ...base, days: count };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Anthropic の日次コストと、API キー × モデル別のトークン内訳。
 *
 * `cost_report` の `amount` は**最小通貨単位 (セント) の文字列**なので 100 で割る。
 * `usage_report/messages` は金額を返さないので、内訳の金額は単価表で換算する。
 */
export async function ingestAnthropic(days: number, now: Date = new Date()): Promise<IngestResult> {
  const base: IngestResult = { provider: LlmProvider.anthropic, days: 0, usageRows: 0, skipped: false, error: null };
  const key = process.env.ANTHROPIC_ADMIN_KEY?.trim();
  if (!key) return { ...base, skipped: true };

  const startingAt = floorToUtcDay(new Date(now.getTime() - days * DAY_MS)).toISOString();
  const headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
  const limit = Math.min(days + 1, 31);

  try {
    const cost = (await fetchJson(
      `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${encodeURIComponent(startingAt)}&bucket_width=1d&limit=${limit}`,
      headers,
    )) as { has_more?: boolean; data?: { starting_at?: string; results?: { amount?: string; currency?: string }[] }[] };
    warnIfTruncated("Anthropic cost_report", cost);

    let count = 0;
    for (const bucket of cost.data ?? []) {
      if (!bucket.starting_at) continue;
      const dateOnly = toJstDateOnly(new Date(bucket.starting_at));
      if (!dateOnly) continue;
      // amount はセント建ての文字列
      const cents = (bucket.results ?? []).reduce((sum, r) => sum + Number(r.amount ?? 0), 0);
      await upsertProviderCost(dateOnly, LlmProvider.anthropic, cents / 100, "anthropic:cost_report");
      count++;
    }

    // 内訳の取り込みが失敗しても、確定金額 (上で書けた分) は活かす
    try {
      const usageRows = await ingestAnthropicUsage(startingAt, headers, limit);
      return { ...base, days: count, usageRows };
    } catch (e) {
      return { ...base, days: count, error: `内訳の取り込みに失敗: ${e instanceof Error ? e.message : String(e)}` };
    }
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

/** キー × モデル別のトークンを取り込む (ふぃたん Discord と手元の Claude Code を分けるため) */
async function ingestAnthropicUsage(startingAt: string, headers: Record<string, string>, limit: number): Promise<number> {
  const labels = anthropicKeyFeatures();
  const url =
    `https://api.anthropic.com/v1/organizations/usage_report/messages?starting_at=${encodeURIComponent(startingAt)}` +
    `&bucket_width=1d&limit=${limit}&group_by[]=api_key_id&group_by[]=model`;
  const json = (await fetchJson(url, headers)) as {
    has_more?: boolean;
    data?: {
      starting_at?: string;
      results?: {
        api_key_id?: string | null;
        model?: string | null;
        uncached_input_tokens?: number;
        cache_read_input_tokens?: number;
        output_tokens?: number;
        cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
      }[];
    }[];
  };

  warnIfTruncated("Anthropic usage_report", json);

  let total = 0;
  for (const bucket of json.data ?? []) {
    if (!bucket.starting_at) continue;
    const dateOnly = toJstDateOnly(new Date(bucket.starting_at));
    if (!dateOnly) continue;
    const rows = (bucket.results ?? [])
      .filter((r) => r.model)
      .map((r) => {
        // feature は小文字で揃える (FEATURE_PATTERN と同じ形にする)
        const keyId = (r.api_key_id ?? "console").toLowerCase();
        const cacheCreation =
          (r.cache_creation?.ephemeral_1h_input_tokens ?? 0) + (r.cache_creation?.ephemeral_5m_input_tokens ?? 0);
        return {
          model: r.model!,
          feature: labels[keyId] ?? `anthropic:${keyId}`,
          // キャッシュ書き込みは入力として数える (単価は入力より高いので控えめな見積もり)
          inputTokens: (r.uncached_input_tokens ?? 0) + cacheCreation,
          cachedInputTokens: r.cache_read_input_tokens ?? 0,
          outputTokens: r.output_tokens ?? 0,
          requests: 0,
        };
      });
    total += await replaceProviderUsage(dateOnly, LlmProvider.anthropic, rows);
  }
  return total;
}

/** 取り込み全体。日数は「確定遅れ」に備えて数日分を毎回上書きする */
export async function ingestAllProviders(days: number, now: Date = new Date()): Promise<IngestResult[]> {
  return [await ingestOpenAi(days, now), await ingestAnthropic(days, now)];
}
