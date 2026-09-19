import { LlmProvider } from "@prisma/client";
import { toJstDateOnly } from "@/lib/utils";
import { makeFeatureResolver, readKeyFeatureMap, type FeatureResolver } from "./keys";
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

/**
 * ページングを追って全ページを集める。1 ページ目しか読まないと日やキーが欠ける。
 *
 * **2 方式ある。** 利用量・コスト系は `next_page` のカーソル、キーの一覧系は
 * `last_id` を `after` / `after_id` に渡す形。両対応にしておかないと、キーが 100 本を
 * 超えた組織で名前が引けず、feature がキー ID のまま出る。
 */
async function fetchAllPages<T>(
  url: string,
  headers: Record<string, string>,
  cursor: { kind: "next_page"; param: string } | { kind: "last_id"; param: string },
  maxPages = 10,
): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const sep = url.includes("?") ? "&" : "?";
    const u: string = next ? `${url}${sep}${cursor.param}=${encodeURIComponent(next)}` : url;
    const json = (await fetchJson(u, headers)) as {
      data?: T[];
      has_more?: boolean;
      next_page?: string | null;
      last_id?: string | null;
    };
    const data = json.data ?? [];
    out.push(...data);
    if (!json.has_more) return out;
    next =
      cursor.kind === "next_page"
        ? (json.next_page ?? null)
        : (json.last_id ?? (data[data.length - 1] as { id?: string } | undefined)?.id ?? null);
    if (!next) return out;
  }
  console.warn(`[costs] ${new URL(url).pathname} のページングが ${maxPages} ページを超えました`);
  return out;
}

/**
 * キー名の取得結果。**「引けなかった」と「1 本も無い」を区別する。**
 *
 * 区別しないと、一時的な 429 や権限の欠落で feature が `openai:key_abc123` に化け、
 * 名前で入った過去の行と並んで 2 行に割れる (取り込み直すのは直近 3 日分だけなので
 * 最大 30 日残る)。引けなかった回は内訳の取り込み自体を見送る。
 */
interface KeyNames {
  names: Map<string, string>;
  ok: boolean;
}

/** OpenAI のキー ID → キー名。プロジェクトを列挙してそれぞれの API キーを引く */
async function fetchOpenAiKeyNames(key: string): Promise<KeyNames> {
  const headers = { Authorization: `Bearer ${key}` };
  const names = new Map<string, string>();
  try {
    // アーカイブ済みのプロジェクトにも過去の利用がある
    const projects = await fetchAllPages<{ id?: string }>(
      "https://api.openai.com/v1/organization/projects?limit=100&include_archived=true",
      headers,
      { kind: "last_id", param: "after" },
      5,
    );
    const perProject = await Promise.all(
      projects
        .filter((p) => p.id)
        .map((p) =>
          // owner_project_access=any にしないと、見えないキーが黙って落ちる
          fetchAllPages<{ id?: string; name?: string }>(
            `https://api.openai.com/v1/organization/projects/${p.id}/api_keys?limit=100&owner_project_access=any`,
            headers,
            { kind: "last_id", param: "after" },
            5,
          ),
        ),
    );
    for (const keys of perProject) for (const k of keys) if (k.id && k.name) names.set(k.id, k.name);
    return { names, ok: true };
  } catch (e) {
    console.warn(`[costs] OpenAI のキー名を引けませんでした: ${e instanceof Error ? e.message : String(e)}`);
    return { names, ok: false };
  }
}

/** Anthropic のキー ID → キー名 (Admin API) */
async function fetchAnthropicKeyNames(headers: Record<string, string>): Promise<KeyNames> {
  const names = new Map<string, string>();
  try {
    const keys = await fetchAllPages<{ id?: string; name?: string }>(
      "https://api.anthropic.com/v1/organizations/api_keys?limit=100",
      headers,
      { kind: "last_id", param: "after_id" },
      5,
    );
    for (const k of keys) if (k.id && k.name) names.set(k.id, k.name);
    return { names, ok: true };
  } catch (e) {
    console.warn(`[costs] Anthropic のキー名を引けませんでした: ${e instanceof Error ? e.message : String(e)}`);
    return { names, ok: false };
  }
}

/** キー名を引けなかった回に内訳の取り込みを見送ったことを表す */
class KeyNamesUnavailable extends Error {
  constructor() {
    super("キー名を引けなかったため内訳の取り込みを見送りました (金額は取り込み済み)");
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

/**
 * OpenAI の日次コスト。`GET /v1/organization/costs` は UTC 日次バケットで
 * `{ data: [{ start_time, results: [{ amount: { value, currency } }] }] }` を返す。
 */
export async function ingestOpenAi(days: number, now: Date = new Date()): Promise<IngestResult> {
  const base: IngestResult = { provider: LlmProvider.openai, days: 0, usageRows: 0, skipped: false, error: null };
  const key = process.env.OPENAI_ADMIN_KEY?.trim();
  if (!key) return { ...base, skipped: true };

  const headers = { Authorization: `Bearer ${key}` };
  const startTime = Math.floor(floorToUtcDay(new Date(now.getTime() - days * DAY_MS)).getTime() / 1000);
  // 1d バケットの上限は両社とも 31
  const limit = Math.min(days + 1, 31);

  try {
    const buckets = await fetchAllPages<{ start_time?: number; results?: { amount?: { value?: number } }[] }>(
      `https://api.openai.com/v1/organization/costs?start_time=${startTime}&bucket_width=1d&limit=${limit}`,
      headers,
      { kind: "next_page", param: "page" },
    );
    let count = 0;
    for (const bucket of buckets) {
      if (typeof bucket.start_time !== "number") continue;
      const dateOnly = toJstDateOnly(new Date(bucket.start_time * 1000));
      if (!dateOnly) continue;
      const amount = (bucket.results ?? []).reduce((sum, r) => sum + (r.amount?.value ?? 0), 0);
      await upsertProviderCost(dateOnly, LlmProvider.openai, amount, "openai:costs");
      count++;
    }

    // 内訳の取り込みが失敗しても、確定金額 (上で書けた分) は活かす
    try {
      const usageRows = await ingestOpenAiUsage(key, headers, startTime, days);
      return { ...base, days: count, usageRows };
    } catch (e) {
      return { ...base, days: count, error: `内訳の取り込みに失敗: ${e instanceof Error ? e.message : String(e)}` };
    }
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * OpenAI のキー × モデル別のトークン。`usage/completions` は `group_by[]` に
 * `api_key_id` と `model` を取れる (`costs` はキー単位に割れないのでこちらで補う)。
 *
 * **金額はここでは確定しない。** 単価表で換算した推定値を入れ、正は `LlmCostDaily` に置く。
 */
async function ingestOpenAiUsage(
  key: string,
  headers: Record<string, string>,
  startTime: number,
  days: number,
): Promise<number> {
  const limit = Math.min(days + 1, 31);
  const keyNames = await fetchOpenAiKeyNames(key);
  if (!keyNames.ok) throw new KeyNamesUnavailable();
  const resolve: FeatureResolver = makeFeatureResolver(
    "openai",
    readKeyFeatureMap(process.env.OPENAI_KEY_FEATURES, "OPENAI_KEY_FEATURES"),
    keyNames.names,
  );

  const buckets = await fetchAllPages<{
    start_time?: number;
    results?: {
      api_key_id?: string | null;
      model?: string | null;
      input_tokens?: number;
      input_cached_tokens?: number;
      output_tokens?: number;
      num_model_requests?: number;
    }[];
  }>(
    `https://api.openai.com/v1/organization/usage/completions?start_time=${startTime}&bucket_width=1d` +
      `&limit=${limit}&group_by[]=api_key_id&group_by[]=model`,
    headers,
    { kind: "next_page", param: "page" },
  );

  let total = 0;
  for (const bucket of buckets) {
    if (typeof bucket.start_time !== "number") continue;
    const dateOnly = toJstDateOnly(new Date(bucket.start_time * 1000));
    if (!dateOnly) continue;
    const rows = (bucket.results ?? [])
      .filter((r) => r.model)
      .map((r) => ({
        model: r.model!,
        feature: resolve(r.api_key_id),
        // input_tokens はキャッシュ分を含むので引く (akashic の inputTokens は「キャッシュ以外」)
        inputTokens: Math.max((r.input_tokens ?? 0) - (r.input_cached_tokens ?? 0), 0),
        cachedInputTokens: r.input_cached_tokens ?? 0,
        outputTokens: r.output_tokens ?? 0,
        requests: r.num_model_requests ?? 0,
      }));
    total += await replaceProviderUsage(dateOnly, LlmProvider.openai, rows);
  }
  return total;
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
    const costBuckets = await fetchAllPages<{ starting_at?: string; results?: { amount?: string; currency?: string }[] }>(
      `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${encodeURIComponent(startingAt)}&bucket_width=1d&limit=${limit}`,
      headers,
      { kind: "next_page", param: "page" },
    );

    let count = 0;
    for (const bucket of costBuckets) {
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
  const keyNames = await fetchAnthropicKeyNames(headers);
  if (!keyNames.ok) throw new KeyNamesUnavailable();
  const resolve: FeatureResolver = makeFeatureResolver(
    "anthropic",
    readKeyFeatureMap(process.env.ANTHROPIC_KEY_FEATURES, "ANTHROPIC_KEY_FEATURES"),
    keyNames.names,
  );
  const buckets = await fetchAllPages<{
    starting_at?: string;
    results?: {
      api_key_id?: string | null;
      model?: string | null;
      uncached_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
      cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
    }[];
  }>(
    `https://api.anthropic.com/v1/organizations/usage_report/messages?starting_at=${encodeURIComponent(startingAt)}` +
      `&bucket_width=1d&limit=${limit}&group_by[]=api_key_id&group_by[]=model`,
    headers,
    { kind: "next_page", param: "page" },
  );

  let total = 0;
  for (const bucket of buckets) {
    if (!bucket.starting_at) continue;
    const dateOnly = toJstDateOnly(new Date(bucket.starting_at));
    if (!dateOnly) continue;
    const rows = (bucket.results ?? [])
      .filter((r) => r.model)
      .map((r) => {
        const cacheCreation =
          (r.cache_creation?.ephemeral_1h_input_tokens ?? 0) + (r.cache_creation?.ephemeral_5m_input_tokens ?? 0);
        return {
          model: r.model!,
          feature: resolve(r.api_key_id),
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
