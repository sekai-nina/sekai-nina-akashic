import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * 記事 Markdown の frontmatter を読み書きする。
 *
 * 記事の実体は別リポジトリ sekai-nina/sekai-nina-public。akashic 側の DB を
 * 編集バッファにする都合上、push 時に frontmatter を丸ごと生成し直す。
 * したがって Article モデルで持たないキー (featured_quotes / locations / dossier 等) は
 * frontmatterExtra に退避し、書き出し時に復元しないと元データを壊す。
 */

/** Article モデルが専用カラムとして持つ frontmatter のキー */
export const KNOWN_FRONTMATTER_KEYS = [
  "title",
  "short_id",
  "type",
  "tags",
  "date",
  "date_display",
  "date_mode",
  "published_at",
  "updated_at",
  "draft",
  "unlisted",
  "ongoing",
  "lat",
  "lng",
  "source",
] as const;

export type ArticleSourceEntry = {
  /** 記事内の脚注番号。本文の ^[n] と対応する */
  id?: number;
  url?: string;
  label?: string;
  date?: string;
  /** akashic の Asset ID (cuid) */
  ref?: string;
};

export type ParsedArticle = {
  frontmatter: Record<string, unknown>;
  /** Article モデルで持たないキーだけを集めたもの */
  extra: Record<string, unknown>;
  sources: ArticleSourceEntry[];
  body: string;
};

const FM_DELIMITER = /^---\r?\n/;

/** frontmatter と本文を分割する。frontmatter が無ければ全文を本文として返す */
export function splitFrontmatter(raw: string): { yaml: string; body: string } {
  if (!FM_DELIMITER.test(raw)) return { yaml: "", body: raw };
  const rest = raw.replace(FM_DELIMITER, "");
  const end = rest.search(/^---\r?\n?/m);
  if (end === -1) return { yaml: "", body: raw };
  const yaml = rest.slice(0, end);
  const body = rest.slice(end).replace(/^---\r?\n?/, "");
  return { yaml, body };
}

/**
 * source[] を正規化する。
 * - `lable` は `label` の誤記 (attribute/好奇心がある.md に実在する) なので吸収する
 * - id / url / label / ref がすべて空の項目は下書きテンプレートの残骸なので捨てる
 */
function normalizeSources(value: unknown): ArticleSourceEntry[] {
  if (!Array.isArray(value)) return [];
  const out: ArticleSourceEntry[] = [];
  for (const item of value) {
    if (item == null || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const str = (v: unknown) => {
      if (v == null) return undefined;
      const s = String(v).trim();
      return s === "" ? undefined : s;
    };
    const entry: ArticleSourceEntry = {
      id: typeof raw.id === "number" ? raw.id : Number(raw.id) || undefined,
      url: str(raw.url),
      label: str(raw.label) ?? str(raw.lable),
      date: str(raw.date),
      ref: str(raw.ref),
    };
    // 中身が何も無い項目 (下書きの空テンプレート) は捨てる
    if (!entry.url && !entry.label && !entry.ref) continue;
    out.push(entry);
  }
  return out;
}

export function parseArticle(raw: string): ParsedArticle {
  const { yaml, body } = splitFrontmatter(raw);
  let frontmatter: Record<string, unknown> = {};
  if (yaml.trim() !== "") {
    const parsed = parseYaml(yaml) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  }

  const known = new Set<string>(KNOWN_FRONTMATTER_KEYS);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    if (!known.has(k)) extra[k] = v;
  }

  return {
    frontmatter,
    extra,
    sources: normalizeSources(frontmatter.source),
    body: body.replace(/^\r?\n/, ""),
  };
}

/** frontmatter + 本文を Markdown に組み立て直す (push 用) */
export function serializeArticle(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  // undefined のキーは書き出さない (null を書くと Astro 側の transform が別扱いになる)
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v !== undefined) clean[k] = v;
  }
  const yaml = stringifyYaml(clean, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\r?\n+/, "")}`;
}
