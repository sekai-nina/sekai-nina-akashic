import { ArticleSourceStatus, ArticleType, ClearanceLevel, PlaceCertainty } from "@prisma/client";
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
  "locations の聖地 (place_id) は ArticlePlace に入り、書き出しでは座標直書きの要素より前に並ぶ。name は聖地の正式名になる",
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

/**
 * frontmatter の `locations` のうち聖地 (`place_id`) を指す要素 (ファイル側の形)。
 * 取り込みは `ArticlePlace` の行にする。座標を直書きした要素はこの形にならず
 * `frontmatterExtra.locations` に残る
 */
export interface ArticlePlaceEntry {
  placeId: string;
  name: string;
  /** 訪問の確度 (#333)。ファイルに `certainty: likely` が無ければ confirmed */
  certainty: PlaceCertainty;
  /** likely の理由 (`certainty_note`)。confirmed なら "" */
  certaintyNote: string;
}

/**
 * DB の ArticlePlace 行のうち、frontmatter の組み立てに要る列。
 *
 * `classification` は紐づく Place のもの。型で必須にしておくのは `ArticleSourceRow` と同じ理由
 * (絞り込みを迂回する詰め替えをコンパイル時に防ぐ。絞り込みは `buildFrontmatter` がやる)。
 * `name` は push 時点の聖地の正式名 (`Entity.canonicalName`)
 */
export interface ArticlePlaceRow {
  placeId: string;
  name: string;
  classification: ClearanceLevel;
  sortOrder: number;
  /** 訪問の確度 (#333)。likely だけ `certainty` / `certainty_note` を書き出す */
  certainty: PlaceCertainty;
  certaintyNote: string;
}

/**
 * 聖地の要素 (`locations[]`) の書き出し。確定 (confirmed) は `name` / `place_id` だけ
 * (#333 より前の記事と 1 文字も変わらない)。ほぼ確定 (likely) は `certainty: likely` と、理由があれば `certainty_note`
 */
export function placeLocationToYaml(p: Pick<ArticlePlaceRow, "name" | "placeId" | "certainty" | "certaintyNote">): Record<string, string> {
  const loc: Record<string, string> = { name: p.name, place_id: p.placeId };
  if (p.certainty === PlaceCertainty.likely) {
    loc.certainty = PlaceCertainty.likely;
    const note = p.certaintyNote.trim();
    if (note) loc.certainty_note = note;
  }
  return loc;
}

/** ファイルの `certainty` / `certainty_note` を読む。likely 以外 (無い・知らない値) は確定 */
function parseCertainty(loc: Record<string, unknown>): { certainty: PlaceCertainty; certaintyNote: string } {
  if (loc.certainty !== PlaceCertainty.likely) return { certainty: PlaceCertainty.confirmed, certaintyNote: "" };
  return { certainty: PlaceCertainty.likely, certaintyNote: (str(loc.certainty_note) ?? "").trim() };
}

/**
 * frontmatter の `locations` に載せてよい聖地か。**public / internal だけ。**
 *
 * 公開サイトの聖地マップは `GET /places` (internal のキー) を読むので、internal までが
 * サイトに出る範囲。confidential 以上は「公開サイトに出したくないが記事との関係は
 * akashic で持ちたい」聖地 (#283) なので、紐づけは DB にだけ残して書き出さない
 */
export function isPublishablePlace(row: Pick<ArticlePlaceRow, "classification">): boolean {
  return row.classification === ClearanceLevel.public || row.classification === ClearanceLevel.internal;
}

/**
 * `locations` の聖地をそのまま DB の行の形にする (並び順 = ファイルの順)。
 * `name` はファイルに書かれた名前、`classification` は呼び出し側が決める
 * (取り込みは Place の実際の値、往復テストは internal = 書き出される側)
 */
export function toArticlePlaceRows(
  entries: ArticlePlaceEntry[],
  classificationOf: (placeId: string) => ClearanceLevel = () => ClearanceLevel.internal,
): ArticlePlaceRow[] {
  return entries.map((e, i) => ({
    placeId: e.placeId,
    name: e.name,
    classification: classificationOf(e.placeId),
    sortOrder: i,
    certainty: e.certainty,
    certaintyNote: e.certaintyNote,
  }));
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

/** Article.type に入れてよい値。取り込みと編集フォームの検証で共有する */
export const ARTICLE_TYPES: ReadonlySet<string> = new Set<string>(Object.values(ArticleType));

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
export interface ArticleColumns extends Omit<ArticleFrontmatterInput, "sources" | "places"> {
  path: string;
  slug: string | null;
  body: string;
  type: ArticleType | null;
  title: string;
  tags: unknown[];
  frontmatterExtra: Record<string, unknown>;
  sources: ArticleSourceEntry[];
  /** `locations` の聖地 (ファイルの並び順)。DB の行にするのは取り込み CLI */
  places: ArticlePlaceEntry[];
}

/**
 * パース結果を Article のカラムに落とす。**取り込みと往復テストの両方がこれを使う。**
 *
 * `buildFrontmatter` のちょうど逆向き。片方だけ直すと往復が崩れるので、
 * この 2 つは必ず同じファイルに置いて一緒に直す。CLI 側にコピーを持つと
 * 「テストは通るが本番の取り込みは別の規則で動く」状態になる。
 */
export function toArticleColumns(parsed: ParsedArticle, path: string): ArticleColumns {
  const { frontmatter: fm, sources, body } = parsed;
  const { places, extra } = splitLocations(parsed.extra);
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
    places,
  };
}

/**
 * `locations` から聖地 (`place_id`) の要素を抜き出す。残り (座標直書き) は extra に残し、
 * 残りが無ければキーごと消す。`place_id` の要素は name / place_id / certainty / certainty_note しか持たない前提
 * (それ以外のキーは書き出しで消える。`verify.ts` の lossyParseNotes が知らせる)。
 * 同じ聖地が 2 回出てきたら 1 回にする (`ArticlePlace` は記事×聖地で一意)
 */
export function splitLocations(extra: Record<string, unknown>): {
  places: ArticlePlaceEntry[];
  extra: Record<string, unknown>;
} {
  const locations = extra.locations;
  if (!Array.isArray(locations)) return { places: [], extra };
  const places: ArticlePlaceEntry[] = [];
  const rest: unknown[] = [];
  const seen = new Set<string>();
  for (const loc of locations) {
    const placeId = loc && typeof loc === "object" ? str((loc as Record<string, unknown>).place_id) : undefined;
    if (!placeId) {
      rest.push(loc);
      continue;
    }
    if (seen.has(placeId)) continue;
    seen.add(placeId);
    const obj = loc as Record<string, unknown>;
    places.push({ placeId, name: str(obj.name) ?? "", ...parseCertainty(obj) });
  }
  if (!places.length) return { places, extra };
  const { locations: _locations, ...others } = extra;
  return { places, extra: rest.length ? { ...others, locations: rest } : others };
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
  /** ArticlePlace の行。絞り込み (public / internal だけ) は `buildFrontmatter` が行う */
  places?: ArticlePlaceRow[];
  /**
   * 書き出してよい聖地の ID (Place が public / internal)。**push は必ず渡す。**
   * `frontmatterExtra.locations` にまだ残っている `place_id` の要素 (backfill 前・backfill が
   * 移せなかった記事・取り込み時に akashic に無かった聖地) は、ここに無ければ落とす (fail-closed)。
   * 渡さない (往復テスト・取り込みの dirty 判定) ときは素通し
   */
  publishablePlaceIds?: ReadonlySet<string>;
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

  // locations = 聖地 (ArticlePlace。public / internal だけ) + 座標直書き (frontmatterExtra)
  // 同じ sortOrder は placeId で決める (見えない行は番号を振り直されないので同値がありうる。
  // push のたびに順序が入れ替わらないように)
  const placeLocations = (input.places ?? [])
    .filter(isPublishablePlace)
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.placeId < b.placeId ? -1 : a.placeId > b.placeId ? 1 : 0))
    .map(placeLocationToYaml);
  const linkedIds = new Set(placeLocations.map((l) => l.place_id));
  /** extra に残った `place_id` の要素。ArticlePlace と重複するもの・書き出せない聖地は落とす */
  const keepExtraLocation = (loc: unknown) => {
    const placeId = loc && typeof loc === "object" ? str((loc as Record<string, unknown>).place_id) : undefined;
    if (!placeId) return true;
    if (linkedIds.has(placeId)) return false;
    return input.publishablePlaceIds ? input.publishablePlaceIds.has(placeId) : true;
  };

  // モデル化されていないキー (featured_quotes / locations / dossier 等) を復元する。
  // 専用カラムと衝突するキーはカラム側が正なので無視する
  const extra = input.frontmatterExtra;
  const entries =
    extra && typeof extra === "object" && !Array.isArray(extra)
      ? Object.entries(extra as Record<string, unknown>)
      : [];
  const known = new Set<string>(KNOWN_FRONTMATTER_KEYS);
  let locationsDone = false;
  const writeLocations = (inline: unknown) => {
    locationsDone = true;
    // 配列でない / 空配列の locations は今までどおりそのまま書く (聖地が無いときだけ)
    if (!Array.isArray(inline)) {
      if (placeLocations.length) fm.locations = placeLocations;
      else if (inline !== undefined) fm.locations = inline;
      return;
    }
    const rest = inline.filter(keepExtraLocation);
    if (!placeLocations.length && rest.length === inline.length) {
      fm.locations = inline;
      return;
    }
    const all = [...placeLocations, ...rest];
    if (all.length) fm.locations = all;
  };
  for (const [k, v] of entries) {
    if (known.has(k) || v === undefined) continue;
    if (k === "locations") {
      writeLocations(v);
      continue;
    }
    // extra に locations が無い (聖地だけの記事) ときは、jsonb がキーを並べる順
    // (長さ → バイト順) で locations が来る位置に差し込む。取り込み前は locations も
    // jsonb に入っていたので、ArticlePlace に移しても書き出しのキー順が変わらない
    if (!locationsDone && placeLocations.length && jsonbKeyBefore("locations", k)) writeLocations(undefined);
    fm[k] = v;
  }
  if (!locationsDone) writeLocations(undefined);

  return { frontmatter: fm, pending, blocked };
}

/** jsonb のキー順 (短い順、同じ長さならバイト順) で a が b より前か */
function jsonbKeyBefore(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return ab.length < bb.length;
  for (let i = 0; i < ab.length; i++) if (ab[i] !== bb[i]) return ab[i] < bb[i];
  return false;
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

/** `renderArticleMarkdown` の戻り。`BuiltFrontmatter` の内訳に Markdown を足したもの */
export interface RenderedMarkdown extends Omit<BuiltFrontmatter, "frontmatter"> {
  /** 公開リポジトリに書き出す Markdown (frontmatter + 本文) */
  markdown: string;
}

/**
 * Article の行 + 出典 → push 用 Markdown。`buildFrontmatter` と `serializeArticle` を
 * 続けて呼ぶだけだが、**push (domain) / 取り込みの dirty 判定 / 往復テスト**の 3 箇所が
 * 同じ経路を通るようにここに 1 つだけ置く。別々に組むと、片方だけ直して
 * 「テストは緑だが push は別の形を書く」状態になる。
 *
 * `blocked` の扱いは呼び出し側が決める (push は拒否、取り込みは不変条件違反として throw)。
 */
export function renderArticleMarkdown(
  input: ArticleFrontmatterInput & { body: string },
): RenderedMarkdown {
  const { frontmatter, pending, blocked } = buildFrontmatter(input);
  return { markdown: serializeArticle(frontmatter, input.body), pending, blocked };
}
