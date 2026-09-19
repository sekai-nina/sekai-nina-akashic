/**
 * ミーグリの素材候補 (ブログ / トーク) の分類と初期チェックの判定。
 *
 * DB を触らない純粋関数。分類は `asset.kind` ではなく **出典 (SourceRecord)** で行う
 * (トークのスクショは `kind: image` で来るので、kind で分けるとブログ画像に化ける。
 * sekai-nina-site の generate.py で実戦で判明したルール)。
 *
 *   - 本人ブログ: 出典 URL が `/diary/detail/`。URL ごとに 1 グループ (本文 text + 画像)
 *   - ひなたぼっこ日記 (運営ブログ): 出典 URL が `/diary/manager/`。本文 text には本人の
 *     人物エンティティが付かないので、候補の外から本文を引いて (staffTexts) キーワード判定する
 *   - トーク: `トーク` タグ、または出典タイトルが `Talk` 始まり
 *   - その他: 上のどれでもない (YouTube 等)。列挙はするが初期チェックしない
 */

import type { AssetKind } from "@prisma/client";
import { jstDayString } from "@/lib/utils";
import { CANDIDATE_TEXT_PREVIEW_CHARS, MEETGREET_KEYWORDS, TALK_SUGGEST_DAYS } from "./config";

export type CandidateGroupKind = "blog" | "staff" | "talk" | "other";

export interface CandidateAssetInput {
  id: string;
  kind: AssetKind;
  title: string;
  /** Asset.canonicalDate (JST 深夜 = 前日 15:00 UTC の規約) */
  canonicalDate: Date | null;
  thumbnailUrl: string | null;
  source: { url: string | null; title: string } | null;
  /** body / message_body の本文。キーワード判定にだけ使う */
  text: string | null;
  hasTalkTag: boolean;
}

export interface CandidateAsset {
  id: string;
  kind: AssetKind;
  title: string;
  canonicalDate: string | null;
  thumbnailUrl: string | null;
  /** 既にドシエに入っている (チェック不可・済み表示) */
  inDossier: boolean;
  /** 初期チェック */
  suggested: boolean;
  /**
   * 本文の頭 (#135)。題だけでは何の話か分からないので画面に出す。
   * 本文を持たないもの (画像・動画) は null
   */
  textPreview: string | null;
}

export interface CandidateGroup {
  key: string;
  kind: CandidateGroupKind;
  /** ブログの題。トーク / その他はグループ名がラベルそのものなので空 (画面は kind のラベルを出す) */
  title: string;
  url: string | null;
  /** グループ内にキーワード一致の本文があった (ブログ / 運営ブログ) */
  matched: boolean;
  assets: CandidateAsset[];
}

export interface ClassifyOptions {
  /** 開催日 (JST "YYYY-MM-DD") */
  date: string;
  /**
   * 開催日が複数あるとき (ライブの公演日 #148)。トークの初期チェックは
   * **どれかの日〜 +TALK_SUGGEST_DAYS** に入っていれば付ける。未指定なら `date` だけ
   */
  dates?: string[];
  /** 本文の初期チェックに使うキーワード。未指定ならミーグリのもの */
  keywords?: readonly string[];
  /** 既にドシエに入っているアセット ID */
  inDossier: Set<string>;
  /** 運営ブログの URL → 本文。候補 (本人タグ付き) には本文 text が含まれないので別引き */
  staffTexts: Map<string, string>;
}

export function matchesKeywords(
  text: string | null | undefined,
  keywords: readonly string[] = MEETGREET_KEYWORDS
): boolean {
  if (!text) return false;
  return keywords.some((k) => k && text.includes(k));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `base` (JST の暦日) から何日目かを返す。当日 = 0、翌日 = 1。
 * `canonicalDate` は JST 深夜 (= 前日 15:00 UTC) の規約なので、`jstDayString` と同じく
 * +9h して UTC 暦日に寄せてから差を取る。
 */
function dayIndex(date: Date | null, base: string): number | null {
  if (!date) return null;
  const jstDay = new Date(`${jstDayString(date)}T00:00:00Z`);
  const baseUtc = new Date(`${base}T00:00:00Z`);
  return Math.round((jstDay.getTime() - baseUtc.getTime()) / DAY_MS);
}

export function classifyGroupKind(a: CandidateAssetInput): CandidateGroupKind {
  const url = a.source?.url ?? "";
  if (url.includes("/diary/detail/")) return "blog";
  if (url.includes("/diary/manager/")) return "staff";
  if (a.hasTalkTag || (a.source?.title ?? "").startsWith("Talk")) return "talk";
  return "other";
}

/** ブログ題 = 画像タイトルの ` (n/N)` を落としたもの */
function blogTitle(assets: CandidateAssetInput[]): string {
  const text = assets.find((a) => a.kind === "text");
  const raw = text?.title ?? assets[0]?.title ?? "";
  return raw.replace(/\s*\(\d+\/\d+\)\s*$/, "");
}

export function classifyCandidates(
  assets: CandidateAssetInput[],
  opts: ClassifyOptions
): CandidateGroup[] {
  const keywords = opts.keywords ?? MEETGREET_KEYWORDS;
  const dates = opts.dates ?? [opts.date];
  const buckets = new Map<string, { kind: CandidateGroupKind; assets: CandidateAssetInput[] }>();
  for (const a of assets) {
    const kind = classifyGroupKind(a);
    const key =
      kind === "blog" || kind === "staff" ? `${kind}:${a.source?.url ?? ""}` : kind;
    const b = buckets.get(key) ?? { kind, assets: [] };
    b.assets.push(a);
    buckets.set(key, b);
  }

  const groups: CandidateGroup[] = [];
  for (const [key, b] of buckets) {
    const sorted = [...b.assets].sort(byDateThenTitle);
    const url = b.kind === "blog" || b.kind === "staff" ? (sorted[0].source?.url ?? null) : null;

    let matched = false;
    if (b.kind === "blog") {
      matched = sorted.some((a) => a.kind === "text" && matchesKeywords(a.text, keywords));
    } else if (b.kind === "staff") {
      const own = sorted.some((a) => a.kind === "text" && matchesKeywords(a.text, keywords));
      matched = own || matchesKeywords(url ? opts.staffTexts.get(url) : null, keywords);
    }

    const items: CandidateAsset[] = sorted.map((a) => {
      let suggested = false;
      if (b.kind === "blog" || b.kind === "staff") {
        suggested = matched;
      } else if (b.kind === "talk") {
        const inWindow = dates.some((base) => {
          const d = dayIndex(a.canonicalDate, base);
          return d !== null && d >= 0 && d <= TALK_SUGGEST_DAYS;
        });
        suggested = a.kind === "text" ? matchesKeywords(a.text, keywords) : inWindow;
      }
      return {
        id: a.id,
        kind: a.kind,
        title: a.title,
        canonicalDate: a.canonicalDate ? a.canonicalDate.toISOString() : null,
        thumbnailUrl: a.thumbnailUrl,
        inDossier: opts.inDossier.has(a.id),
        suggested: suggested && !opts.inDossier.has(a.id),
        textPreview: previewOf(a.text),
      };
    });

    groups.push({
      key,
      kind: b.kind,
      title: b.kind === "blog" || b.kind === "staff" ? blogTitle(sorted) : "",
      url,
      matched,
      assets: items,
    });
  }

  const order: Record<CandidateGroupKind, number> = { blog: 0, staff: 1, talk: 2, other: 3 };
  groups.sort((x, y) => {
    if (order[x.kind] !== order[y.kind]) return order[x.kind] - order[y.kind];
    const dx = x.assets[0]?.canonicalDate ?? "";
    const dy = y.assets[0]?.canonicalDate ?? "";
    return dx < dy ? -1 : dx > dy ? 1 : 0;
  });
  return groups;
}

/** 本文の頭を数行ぶん。空行を詰めて 1 行の無駄を減らす */
function previewOf(text: string | null): string | null {
  if (!text) return null;
  // 整形は頭だけに掛ける (ブログ本文や書き起こし全文に正規表現を通さない)。
  // 空行を詰めるぶん縮むので、余裕を持って多めに取る
  const head = text.slice(0, CANDIDATE_TEXT_PREVIEW_CHARS * 3);
  const body = head.replace(/\r\n?/g, "\n").replace(/\n{2,}/g, "\n").trim();
  if (body.length === 0) return null;
  if (body.length <= CANDIDATE_TEXT_PREVIEW_CHARS && head.length === text.length) return body;
  // **絵文字を割らない。** `slice` は UTF-16 単位なので、サロゲートペアの途中で
  // 切ると � になる (アイドルのブログは絵文字が多い)
  const chars = [...body].slice(0, CANDIDATE_TEXT_PREVIEW_CHARS);
  return chars.length < [...body].length || head.length < text.length
    ? `${chars.join("")}…`
    : body;
}

function byDateThenTitle(a: CandidateAssetInput, b: CandidateAssetInput): number {
  const ta = a.canonicalDate?.getTime() ?? 0;
  const tb = b.canonicalDate?.getTime() ?? 0;
  if (ta !== tb) return ta - tb;
  // ブログ画像の (n/N) は数値順に (文字列比較だと 10 が 2 の前に来る)
  const na = Number(a.title.match(/\((\d+)\/\d+\)\s*$/)?.[1] ?? 0);
  const nb = Number(b.title.match(/\((\d+)\/\d+\)\s*$/)?.[1] ?? 0);
  if (na !== nb) return na - nb;
  return a.title.localeCompare(b.title, "ja");
}
