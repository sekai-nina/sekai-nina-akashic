import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * 記事 Markdown の frontmatter を読み書きする。
 *
 * 記事の実体は別リポジトリ sekai-nina/sekai-nina-public。akashic 側の DB を
 * 編集バッファにする都合上、push 時に frontmatter を丸ごと生成し直す。
 *
 * **DB は frontmatter をテキストとして持っていない。** 専用カラム +
 * frontmatterExtra + ArticleSource に分解して保存しているので、書き出しは
 * 「保存したものを戻す」のではなく `buildFrontmatter` で組み立て直す作業になる。
 * したがって保証できるのは **値レベルの往復** であって、バイト単位の一致ではない。
 * 意図的に正規化される項目は `INTENTIONAL_NORMALIZATIONS` に列挙してある。
 */

/** Article モデルが専用カラムとして持つ frontmatter のキー。書き出し順もこの順 */
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

/**
 * parse → serialize の往復で **意図的に** 変わるもの。
 * 往復テスト (frontmatter.test.ts) はこの正規化を適用したうえで一致を見る。
 */
export const INTENTIONAL_NORMALIZATIONS = [
  "lable → label (誤記の吸収)",
  "source[] の素の文字列 → { label } (Astro のスキーマは両方を許すが DB は object 前提)",
  "url / label / ref がすべて空の source エントリは捨てる (下書きの空テンプレート)",
  "type: fact / state → attribute (Astro 側の transform に合わせる)",
  "false の draft / unlisted / ongoing と空の tags / source はキーごと省く (Astro の既定値と同じ)",
  "キーの順序は KNOWN_FRONTMATTER_KEYS 順 + frontmatterExtra の順に揃える",
  "本文先頭の空行は 1 行に揃える (Markdown の描画には影響しない)",
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

/** 開始デリミタ。`---` だけの行 (末尾の空白は許す) */
const FM_OPEN = /^---[ \t]*\r?\n/;
/** 終端デリミタ。`----` のような 4 本以上や `--- foo` は本文の一部として扱う */
const FM_CLOSE = /^---[ \t]*(\r?\n|$)/m;

/** frontmatter と本文を分割する。frontmatter が無ければ全文を本文として返す */
export function splitFrontmatter(raw: string): { yaml: string; body: string } {
  // BOM が残っていると開始デリミタに一致せず、short_id 無しと判定されて
  // 記事が黙って取り込まれない。先に落とす
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  const open = FM_OPEN.exec(text);
  if (!open) return { yaml: "", body: text };

  const rest = text.slice(open[0].length);
  const close = FM_CLOSE.exec(rest);
  if (!close) return { yaml: "", body: text };

  return {
    yaml: rest.slice(0, close.index),
    body: rest.slice(close.index + close[0].length),
  };
}

const str = (v: unknown): string | undefined => {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
};

/**
 * source[] を正規化する。
 * - `lable` は `label` の誤記 (attribute/好奇心がある.md に実在する) なので吸収する
 * - 素の文字列は「ラベルだけの出典」として扱う。Astro 側のスキーマが
 *   `z.union([z.string(), z.object({…})])` で両方を許しているため実在する
 * - url / label / ref がすべて空の項目は下書きテンプレートの残骸なので捨てる
 */
function normalizeSources(value: unknown): ArticleSourceEntry[] {
  if (!Array.isArray(value)) return [];
  const out: ArticleSourceEntry[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const label = str(item);
      if (label) out.push({ label });
      continue;
    }
    if (item == null || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
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

/** 日付のみの表記。日・月のゼロ埋めが無いものも拾う (`2026-01-8` が実在する) */
const DATE_ONLY = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

/**
 * frontmatter の日付を Date にする。文字列でも Date でも来る。
 *
 * **日付のみの表記は UTC 深夜として保存する。** 既存の取り込み
 * (src/lib/domain/coverage.ts の `T00:00:00.000Z`) と揃えるため。
 * JST 深夜 (+09:00) にすると UTC では前日 15:00 になり、`formatDate` が
 * timeZone 未指定でサーバ TZ に従うせいで、Vercel (UTC) 上だけ日付が
 * 1 日前にズレる (ローカルの Mac は JST なので気づけない)。
 *
 * ゼロ埋めを自前で補うのは、`new Date("2026-01-8")` が **ローカルタイム**
 * 解釈になり、同じズレを踏むため。
 */
export function parseFrontmatterDate(value: unknown): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value;
  const s = String(value).trim();
  const m = DATE_ONLY.exec(s);
  if (m) {
    const [, y, mo, d] = m;
    return new Date(`${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T00:00:00.000Z`);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * DateTime を frontmatter の日付表記に戻す。
 *
 * 取り込み時、日付のみの表記は **UTC 深夜** として保存している
 * (src/cli/import-articles.ts の `toDate`)。したがって UTC 深夜ちょうどなら
 * 元も日付のみだったとみなして `YYYY-MM-DD` に戻す。そうでなければ時刻成分が
 * 書かれていたということなので (`updated_at` に 59 件実在する) ISO のまま返す。
 */
export function formatFrontmatterDate(value: Date | string | null | undefined): string | undefined {
  const d = parseFrontmatterDate(value);
  if (!d) return undefined;
  const iso = d.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
}

/** `buildFrontmatter` の入力。Article の行と、それに紐づく出典 */
export interface ArticleFrontmatterInput {
  shortId: string;
  title?: string | null;
  type?: string | null;
  tags?: unknown;
  date?: Date | string | null;
  dateDisplay?: string | null;
  dateMode?: string | null;
  publishedAt?: Date | string | null;
  articleUpdatedAt?: Date | string | null;
  draft?: boolean;
  unlisted?: boolean;
  ongoing?: boolean;
  lat?: number | null;
  lng?: number | null;
  /** Article モデルで持たない frontmatter の退避先 */
  frontmatterExtra?: unknown;
  sources?: ArticleSourceEntry[];
}

/** source エントリを frontmatter に載る形へ。キー順は id / url / label / date / ref */
function sourceToYaml(e: ArticleSourceEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (e.id != null) out.id = e.id;
  if (e.url) out.url = e.url;
  if (e.label) out.label = e.label;
  const date = formatFrontmatterDate(e.date);
  if (date) out.date = date;
  if (e.ref) out.ref = e.ref;
  return out;
}

/**
 * DB のカラム群から frontmatter オブジェクトを組み立てる。
 *
 * **値が既定と同じキーは省く。** Article の draft / unlisted / ongoing は
 * `@default(false)`、tags は `@default("[]")` なので「元ファイルにキーが無かった」と
 * 「false / 空配列と書いてあった」を DB からは区別できない。Astro 側が
 * `.transform((v) => v ?? false)` で同じ既定を当てているので、省いても値は変わらない。
 */
export function buildFrontmatter(input: ArticleFrontmatterInput): Record<string, unknown> {
  const fm: Record<string, unknown> = {};

  const title = str(input.title);
  if (title) fm.title = title;

  fm.short_id = input.shortId;

  const type = str(input.type);
  if (type) fm.type = type;

  const tags = Array.isArray(input.tags) ? input.tags.filter((t) => str(t)) : [];
  if (tags.length) fm.tags = tags;

  const date = formatFrontmatterDate(input.date);
  if (date) fm.date = date;

  const dateDisplay = str(input.dateDisplay);
  if (dateDisplay) fm.date_display = dateDisplay;

  const dateMode = str(input.dateMode);
  if (dateMode) fm.date_mode = dateMode;

  const publishedAt = formatFrontmatterDate(input.publishedAt);
  if (publishedAt) fm.published_at = publishedAt;

  const updatedAt = formatFrontmatterDate(input.articleUpdatedAt);
  if (updatedAt) fm.updated_at = updatedAt;

  if (input.draft) fm.draft = true;
  if (input.unlisted) fm.unlisted = true;
  if (input.ongoing) fm.ongoing = true;

  if (input.lat != null) fm.lat = input.lat;
  if (input.lng != null) fm.lng = input.lng;

  const sources = (input.sources ?? []).map(sourceToYaml).filter((s) => Object.keys(s).length > 0);
  if (sources.length) fm.source = sources;

  // モデル化されていないキー (featured_quotes / locations / dossier 等) を復元する。
  // 専用カラムと衝突するキーはカラム側が正なので無視する
  const extra = input.frontmatterExtra;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    const known = new Set<string>(KNOWN_FRONTMATTER_KEYS);
    for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
      if (known.has(k) || v === undefined) continue;
      fm[k] = v;
    }
  }

  return fm;
}

/**
 * frontmatter + 本文を Markdown に組み立て直す (push 用)。
 *
 * `#` を含む値の quote は `stringify` が自動で行う (手書きの frontmatter で
 * `label: #5 …` が YAML コメント扱いになって壊れていたのは、この経路を
 * 通っていなかったため)。
 */
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
