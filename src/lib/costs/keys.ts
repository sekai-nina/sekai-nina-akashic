/**
 * API キー ID を人が読める `feature` 名に直す。
 *
 * プロバイダの usage API は `key_abc123` のような ID しか返さないので、そのままでは
 * /costs を見ても何の費用か分からない。各社の Admin API からキー名を引いて
 * `openai:bot` のような形にする。引けなければ ID のまま出す (黙って落とさない)。
 *
 * 優先順位: 環境変数の対応表 > プロバイダから引いた名前 > キー ID。
 * 環境変数を最優先にするのは、キー名が用途を表していないとき
 * (「key1」「個人用」など) に人が上書きできるようにするため。
 *
 * **上書きの値も FEATURE_PATTERN に収める。** ここは REST の検証を通らない経路なので、
 * 素通しにすると `POST /api/v1/usage` なら 400 になる値が列に入る。
 */

/**
 * 呼び出し元の識別子。`<出所>.<機能>` で揃える (akashic.testimonials / bot.discovery など)。
 * REST の入力検証にも使う。**DB を触らないモジュールに置く** (これを使うテストが
 * PrismaClient を生成しないように)。
 */
export const FEATURE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

/** FEATURE_PATTERN に収まる形に均す */
export function toFeatureName(prefix: string, raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = `${prefix}:${slug || "unknown"}`;
  return name.slice(0, 64);
}

/** `{"key_abc":"openai:bot"}` 形式の環境変数を読む。壊れていても落とさない */
export function readKeyFeatureMap(envValue: string | undefined, envName: string): Record<string, string> {
  const raw = envValue?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn(`[costs] ${envName} はオブジェクトではありません`);
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out[k.toLowerCase()] = v.trim();
    }
    return out;
  } catch {
    console.warn(`[costs] ${envName} が JSON として読めません`);
    return {};
  }
}

export interface FeatureResolver {
  /** キー ID から feature 名を決める。`null` は「キーの指定が無い呼び出し」(コンソール等) */
  (keyId: string | null | undefined): string;
}

/**
 * 対応表とキー名から解決関数を作る。
 *
 * @param prefix   `openai` / `anthropic`
 * @param overrides 環境変数の対応表 (キー ID → feature 名)
 * @param names    プロバイダから引いたキー ID → キー名
 */
export function makeFeatureResolver(
  prefix: string,
  overrides: Record<string, string>,
  names: Map<string, string>,
): FeatureResolver {
  return (keyId) => {
    const id = (keyId ?? "").toLowerCase();
    if (!id) return `${prefix}:console`;
    const override = overrides[id];
    if (override) {
      const trimmed = override.slice(0, 64);
      return FEATURE_PATTERN.test(trimmed) ? trimmed : toFeatureName(prefix, override);
    }
    const name = names.get(keyId ?? "") ?? names.get(id);
    return name ? toFeatureName(prefix, name) : toFeatureName(prefix, id);
  };
}
