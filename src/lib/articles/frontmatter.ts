import { ArticleSourceStatus, ArticleType, ClearanceLevel } from "@prisma/client";
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
 *
 * **`buildFrontmatter` の出力は公開リポジトリに出る。** ArticleSource には
 * akashic 側で付けた紐づけ (pending / 元アセットの classification を継承) も
 * 混ざるので、frontmatter に載せるのは「pending 以外 かつ public」の行だけに
 * 絞る (`isPublishableSource`)。押した人の clearance で出力が変わる経路を
 * 作らないため、この絞り込みはここで行い、呼び出し側には任せない。
 */

/** Article モデルが専用カラムとして持つ frontmatter のキー。書き出し順もこの順 */
export const KNOWN_FRONTMATTER_KEYS = [
  "title",
  "short_id",
  "slug",
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
  "キーの順序は KNOWN_FRONTMATTER_KEYS 順が先、frontmatterExtra 由来のキーが後 (extra 内の順序は jsonb なので保存されない)",
  "本文先頭の空行は 1 行に揃える (Markdown の描画には影響しない)",
  "文字列値は前後の空白を落とす",
] as const;

/** frontmatter の source[] の 1 要素 (ファイル側の形。`parseArticle` の出力) */
export type ArticleSourceEntry = {
  /** 記事内の脚注番号。本文の ^[n] と対応する */
  id?: number;
  url?: string;
  label?: string;
  date?: string;
  /** akashic の Asset ID (cuid) */
  ref?: string;
};

/**
 * DB の ArticleSource 行のうち、frontmatter の組み立てと差分判定に要る列。
 *
 * `buildFrontmatter` はこの形しか受け付けない。status / classification を
 * 型で必須にしておくことで、呼び出し側が「status / classification を持たない形に
 * 詰め替えて絞り込みを迂回する」ことをコンパイル時に防ぐ (絞り込み自体は
 * `buildFrontmatter` がやるので、呼び出し側は全行そのまま渡してよい)。
 * 取り込み (`toArticleSourceRow`) も同じ形を書く。
 */
export interface ArticleSourceRow {
  assetId: string | null;
  status: ArticleSourceStatus;
  classification: ClearanceLevel;
  sourceNo: number | null;
  label: string;
  url: string | null;
  date: Date | null;
  /** 元ファイルに書かれていた ref (status に依らず保持)。akashic 側で付けた行は null */
  originalRef: string | null;
  sortOrder: number;
}

/** `toArticleSourceRow` に渡す照合結果。取り込み CLI の resolve が決める */
export interface SourceResolution {
  assetId: string | null;
  status: ArticleSourceStatus;
}

/**
 * frontmatter の source エントリを DB の行に落とす。**取り込みと往復テストの両方がこれを使う。**
 *
 * - `originalRef` は元ファイルの ref をそのまま保持する。applied でも持っておくと、
 *   Asset が消されて `assetId` が SetNull されたときに元の ref を書き戻せる
 * - `classification` は **public 固定**。frontmatter 由来 = 既に公開リポジトリに
 *   載っている内容なので。ここを internal にすると `buildFrontmatter` の
 *   絞り込みで全 source が消える (silent data loss)
 */
export function toArticleSourceRow(
  entry: ArticleSourceEntry,
  resolved: SourceResolution,
  sortOrder: number,
): ArticleSourceRow {
  return {
    assetId: resolved.assetId,
    status: resolved.status,
    classification: ClearanceLevel.public,
    sourceNo: entry.id ?? null,
    label: entry.label ?? "",
    url: entry.url ?? null,
    date: parseFrontmatterDate(entry.date),
    originalRef: entry.ref ?? null,
    sortOrder,
  };
}

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

/** `Number(v) || undefined` だと 0 や "0" を落とすので、有限かどうかで見る */
const num = (v: unknown): number | undefined => {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
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
      id: num(raw.id),
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
    // serializeArticle は先頭の改行を全部落として `---\n\n` を付け直すので、
    // ここも全部落として対称にする。1 個だけ剥がすと本文が `\n` 始まりの
    // まま DB に入り、ファイルと永久に食い違う (実記事 332 本中 50 本が該当)
    body: body.replace(/^(\r?\n)+/, ""),
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
 *
 * **暦日として存在しない日付は `null` にする。** `new Date("2026-02-30")` は
 * Invalid にならず 3/2 に繰り上がるので、そのまま通すと打ち間違いが別の
 * もっともらしい日付として DB に入り、push で原本を書き換えてしまう
 * (`src/lib/mcp/tools.ts` の日付検証と同じ往復チェック)。
 */
export function parseFrontmatterDate(value: unknown): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  const s = String(value).trim();
  const m = DATE_ONLY.exec(s);
  if (m) {
    const [, y, mo, d] = m;
    const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    const parsed = new Date(`${iso}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return null;
    return parsed;
  }
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * DateTime を frontmatter の日付表記に戻す。
 *
 * 取り込み時、日付のみの表記は **UTC 深夜** として保存している
 * (`parseFrontmatterDate`)。したがって UTC 深夜ちょうどなら元も日付のみだった
 * とみなして `YYYY-MM-DD` に戻し、そうでなければ時刻成分が書かれていたと
 * みなして ISO のまま返す。
 *
 * 実記事の `date` / `published_at` / `updated_at` は現状すべて日付のみなので
 * 後者は保険。`dossier.updated_at` のような入れ子の日時は `frontmatterExtra` に
 * JSON のまま入るので、この関数を通らない。
 */
export function formatFrontmatterDate(value: Date | string | null | undefined): string | undefined {
  const d = parseFrontmatterDate(value);
  if (!d) return undefined;
  const iso = d.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
}

const ARTICLE_TYPES = new Set<string>(Object.values(ArticleType));

/** frontmatter の型を Article.type に落とす。Astro 側の transform に合わせる */
function toType(v: unknown): ArticleType | null {
  if (v == null) return null;
  let s = String(v).trim();
  if (s === "fact" || s === "state") s = "attribute";
  return ARTICLE_TYPES.has(s) ? (s as ArticleType) : null;
}

function toBool(v: unknown): boolean {
  return v === true || v === "true";
}

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * `toArticleColumns` の戻り。`Article` の frontmatter 由来カラムと本文。
 *
 * そのまま `prisma.article.upsert` に渡せるよう、`type` は enum に絞る
 * (`ArticleFrontmatterInput` 側は書き出し専用なので string も許している)。
 * `sources` はまだファイル側の形 (照合前)。DB の行にするのは `toArticleSourceRow`
 */
export interface ArticleColumns extends Omit<ArticleFrontmatterInput, "sources"> {
  path: string;
  slug: string | null;
  body: string;
  type: ArticleType | null;
  title: string;
  tags: unknown[];
  frontmatterExtra: Record<string, unknown>;
  sources: ArticleSourceEntry[];
}

/**
 * パース結果を Article のカラムに落とす。**取り込みと往復テストの両方がこれを使う。**
 *
 * `buildFrontmatter` のちょうど逆向き。片方だけ直すと往復が崩れるので、
 * この 2 つは必ず同じファイルに置いて一緒に直す。CLI 側にコピーを持つと
 * 「テストは通るが本番の取り込みは別の規則で動く」状態になる。
 */
export function toArticleColumns(parsed: ParsedArticle, path: string): ArticleColumns {
  const { frontmatter: fm, extra, sources, body } = parsed;
  return {
    shortId: fm.short_id == null ? "" : String(fm.short_id).trim(),
    path,
    // 空文字はキーが無いのと同じ (buildFrontmatter も Astro も同一視する)。
    // ここで揃えないと "" のまま DB に入り、往復で null になって差分が出る
    slug: str(fm.slug) ?? null,
    title: fm.title == null ? "" : String(fm.title),
    type: toType(fm.type),
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    body,
    date: parseFrontmatterDate(fm.date),
    dateDisplay: str(fm.date_display) ?? null,
    dateMode: str(fm.date_mode) ?? null,
    publishedAt: parseFrontmatterDate(fm.published_at),
    articleUpdatedAt: parseFrontmatterDate(fm.updated_at),
    draft: toBool(fm.draft),
    unlisted: toBool(fm.unlisted),
    ongoing: toBool(fm.ongoing),
    lat: toNum(fm.lat),
    lng: toNum(fm.lng),
    frontmatterExtra: extra,
    sources,
  };
}

/** `buildFrontmatter` の入力。Article の行と、それに紐づく出典 */
export interface ArticleFrontmatterInput {
  shortId: string;
  slug?: string | null;
  title?: string | null;
  type?: ArticleType | string | null;
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
  /** ArticleSource の行。絞り込みは `buildFrontmatter` が行うので全行渡してよい */
  sources?: ArticleSourceRow[];
}

/**
 * frontmatter に載せてよい行か。**pending 以外 かつ public** だけ。
 *
 * - pending は akashic 側で紐づけただけで本文に反映されていない (載せない)
 * - public でない行は、公開リポジトリに出してはいけない。frontmatter 由来の行は
 *   取り込みが public を付けるので、ここで落ちるのは akashic 側で付けた行だけのはず
 */
export function isPublishableSource(row: Pick<ArticleSourceRow, "status" | "classification">): boolean {
  return row.status !== ArticleSourceStatus.pending && row.classification === ClearanceLevel.public;
}

/**
 * DB の行を frontmatter に載る形へ。キー順は id / url / label / date / ref。
 *
 * `ref` は **`assetId ?? originalRef`**。applied なら照合済みの Asset を指し、
 * unresolved (dangling) なら元ファイルの ref をそのまま書き戻す。元ファイルに
 * ref が無く url / label の照合で applied になった行には、ここで初めて ref が
 * 生える (sekai-nina-site の write-refs.ts がやっていた補完と同じ)。
 */
function sourceToYaml(row: ArticleSourceRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (row.sourceNo != null) out.id = row.sourceNo;
  if (row.url) out.url = row.url;
  if (row.label) out.label = row.label;
  const date = formatFrontmatterDate(row.date);
  if (date) out.date = date;
  const ref = row.assetId ?? row.originalRef;
  if (ref) out.ref = ref;
  return out;
}

/** `buildFrontmatter` の戻り。frontmatter 本体と、載せなかった行の内訳 */
export interface BuiltFrontmatter {
  frontmatter: Record<string, unknown>;
  /** 未反映 (pending) のため載せなかった行数。黙って除外してよい */
  pending: number;
  /**
   * applied / unresolved なのに public でない行。本文が ^[n] で参照しているのに
   * 脚注だけ消える矛盾状態なので、**1 件でもあれば push はその記事を拒否する**
   */
  blocked: ArticleSourceRow[];
}

/**
 * DB のカラム群から frontmatter オブジェクトを組み立てる。
 *
 * **この関数の出力は公開リポジトリ sekai-nina/sekai-nina-public に出る。**
 * source は `isPublishableSource` (pending 以外 かつ public) で絞り、落とした行は
 * 戻り値で報告する。呼び出し側は `blocked` が空でないときに push してはいけない。
 *
 * **値が既定と同じキーは省く。** Article の draft / unlisted / ongoing は
 * `@default(false)`、tags は `@default("[]")` なので「元ファイルにキーが無かった」と
 * 「false / 空配列と書いてあった」を DB からは区別できない。Astro 側が
 * `.transform((v) => v ?? false)` で同じ既定を当てているので、省いても値は変わらない。
 */
export function buildFrontmatter(input: ArticleFrontmatterInput): BuiltFrontmatter {
  const fm: Record<string, unknown> = {};

  const title = str(input.title);
  if (title) fm.title = title;

  fm.short_id = input.shortId;

  const slug = str(input.slug);
  if (slug) fm.slug = slug;

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

  let pending = 0;
  const blocked: ArticleSourceRow[] = [];
  const publishable: ArticleSourceRow[] = [];
  for (const row of input.sources ?? []) {
    if (isPublishableSource(row)) publishable.push(row);
    else if (row.status === ArticleSourceStatus.pending) pending++;
    else blocked.push(row);
  }
  // 呼び出し側の並び順に依存しない (DB から引くときの orderBy 忘れで脚注番号と順序がズレる)。
  // sortOrder は取り込みが 0.. を振り直す一方 addAssetToArticle は max+1 を使うので、
  // pending → applied を経た行と衝突しうる。同値は脚注番号で安定させる
  publishable.sort(
    (a, b) => a.sortOrder - b.sortOrder || (a.sourceNo ?? Infinity) - (b.sourceNo ?? Infinity),
  );
  const sources = publishable.map(sourceToYaml).filter((s) => Object.keys(s).length > 0);
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

  return { frontmatter: fm, pending, blocked };
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
